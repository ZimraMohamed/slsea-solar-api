// src/openapi.js

// OpenAPI 3.0 description, served at /openapi.json and rendered at /docs
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const errRes = (description) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
const idParam = (name) => ({ name, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } });
const q = (name, schema, description) => ({ name, in: 'query', required: false, schema, description });

const paging = [
  q('page', { type: 'integer', minimum: 1, default: 1 }, 'Page number'),
  q('page_size', { type: 'integer', minimum: 1, maximum: 500, default: 50 }, 'Items per page'),
];
const geo = [
  q('province_id', { type: 'integer' }, 'Filter by province'),
  q('district_id', { type: 'integer' }, 'Filter by district'),
  q('substation_id', { type: 'integer' }, 'Filter by grid substation'),
];
const readingFilters = [
  ...geo,
  q('installation_id', { type: 'integer' }, 'Filter by installation'),
  q('from', { type: 'string', format: 'date-time' }, 'Start of time window (inclusive)'),
  q('to', { type: 'string', format: 'date-time' }, 'End of time window (inclusive)'),
  q('sort', { type: 'string', enum: ['timestamp', 'power_kw', 'energy_kwh'], default: 'timestamp' }, 'Sort field'),
  q('order', { type: 'string', enum: ['asc', 'desc'], default: 'desc' }, 'Sort direction'),
];

const user = [{ bearerAuth: [] }];
const common = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  406: { $ref: '#/components/responses/NotAcceptable' },
};
const cacheHeaders = {
  ETag: { schema: { type: 'string' }, description: 'Entity tag for conditional GET (If-None-Match)' },
  'Last-Modified': { schema: { type: 'string' }, description: 'For If-Modified-Since' },
};
const notModified = { 304: { description: 'Not Modified (empty body): client already holds the current version' } };
const page = (item) => ({
  200: {
    description: 'A page of results',
    headers: {
      'X-Total-Count': { schema: { type: 'integer' }, description: 'Total matching items' },
      Link: { schema: { type: 'string' }, description: 'RFC 8288 first/prev/next/last links' },
      ETag: cacheHeaders.ETag,
    },
    content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref(item) }, pagination: ref('Pagination'), links: ref('Links') } } } },
  },
  304: notModified[304], ...common,
});
const one = (schema, extra = {}) => ({
  200: { description: 'OK', headers: cacheHeaders, content: { 'application/json': { schema: ref(schema) } } },
  304: notModified[304], 404: { $ref: '#/components/responses/NotFound' }, ...common, ...extra,
});
const get = (tag, summary, parameters, responses, description) => ({ get: { tags: [tag], summary, description, security: user, parameters, responses } });

const invalidBody = { 400: { $ref: '#/components/responses/BadRequest' }, 415: errRes('Unsupported media type') };

export default {
  openapi: '3.0.3',
  info: {
    title: 'SLSEA Real-Time Solar Generation Data API',
    version: '1.0.0',
    description: [
      'REST API (Richardson Maturity Level 2) for solar generation data.',
      '',
      '**Two kinds of client:** metering devices (write readings for their own installation only, scheme `Device`) and SLSEA users (read-only, scoped by jurisdiction, scheme `Bearer`).',
      '',
      'Login with `POST /auth/login`, then use **Authorize** with the returned token. Devices send `Authorization: Device <meter_id>:<device_key>`.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Auth' }, { name: 'Geography' }, { name: 'Installations' },
    { name: 'Readings' }, { name: 'Operational' },
  ],
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Obtain a JWT for an SLSEA user',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Login') } } },
        responses: { 200: { description: 'Token issued', content: { 'application/json': { schema: ref('Token') } } }, 401: errRes('Invalid credentials'), ...invalidBody },
      },
    },
    '/provinces': get('Geography', 'List provinces (scoped)', paging, page('Province')),
    '/provinces/{id}': get('Geography', 'Get a province', [idParam('id')], one('Province')),
    '/provinces/{id}/districts': get('Geography', 'Districts of a province', [idParam('id'), ...paging], page('District')),
    '/districts': get('Geography', 'List districts (scoped)', [q('province_id', { type: 'integer' }, 'Filter by province'), ...paging], page('District')),
    '/districts/{id}': get('Geography', 'Get a district', [idParam('id')], one('District')),
    '/districts/{id}/substations': get('Geography', 'Grid substations of a district', [idParam('id'), ...paging], page('Substation')),
    '/districts/{id}/installations': get('Installations', 'Installations in a district', [idParam('id'), ...paging], page('Installation')),
    '/districts/{id}/generation-summary': get('Operational', 'District generation summary (processing resource)',
      [idParam('id'), q('as_of', { type: 'string', format: 'date-time' }, 'Evaluate as of this instant (default: latest reading in the district)')],
      one('GenerationSummary'),
      'Aggregates across all installations in the district: current total power (latest reading per site within 30 min of as_of) and energy generated today (Sri Lanka local day).'),
    '/substations': get('Geography', 'List grid substations (scoped)', [...geo.slice(0, 2), ...paging], page('Substation')),
    '/substations/{id}': get('Geography', 'Get a grid substation', [idParam('id')], one('Substation')),
    '/substations/{id}/installations': get('Installations', 'Installations on a substation', [idParam('id'), ...paging], page('Installation')),
    '/installations': {
      ...get('Installations', 'List installations (scoped, filterable)', [...geo, q('status', { type: 'string', enum: ['active', 'inactive', 'decommissioned'] }, 'Filter by status'), ...paging], page('Installation')),
      post: {
        tags: ['Installations'], summary: 'Register an installation (national role)', security: user,
        requestBody: { required: true, content: { 'application/json': { schema: ref('InstallationInput') } } },
        responses: {
          201: { description: 'Created', headers: { Location: { schema: { type: 'string' } }, ETag: cacheHeaders.ETag }, content: { 'application/json': { schema: ref('InstallationCreated') } } },
          409: errRes('Duplicate meter_id'), 401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' }, ...invalidBody,
        },
      },
    },
    '/installations/{id}': {
      ...get('Installations', 'Get an installation', [idParam('id')], one('Installation')),
      put: {
        tags: ['Installations'], summary: 'Replace an installation (national role, idempotent)', security: user,
        parameters: [idParam('id'), { name: 'If-Match', in: 'header', required: false, schema: { type: 'string' }, description: 'ETag from a previous GET; 412 if stale' }],
        requestBody: { required: true, content: { 'application/json': { schema: ref('InstallationInput') } } },
        responses: { 200: { description: 'Updated', headers: cacheHeaders, content: { 'application/json': { schema: ref('Installation') } } }, 404: { $ref: '#/components/responses/NotFound' }, 412: errRes('Precondition failed'), 401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' }, ...invalidBody },
      },
      delete: {
        tags: ['Installations'], summary: 'Delete an installation with no history (national role)', security: user,
        parameters: [idParam('id'), { name: 'If-Match', in: 'header', required: false, schema: { type: 'string' } }],
        responses: { 204: { description: 'Deleted' }, 404: { $ref: '#/components/responses/NotFound' }, 409: errRes('Installation has generation history'), 412: errRes('Precondition failed'), 401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/installations/{id}/overview': get('Installations', 'Composite: installation + location + latest snapshot', [idParam('id')], one('InstallationOverview')),
    '/installations/{id}/last-reading': get('Operational', 'Last-known reading (derived resource)', [idParam('id')], one('LastReading')),
    '/installations/{id}/readings': {
      ...get('Readings', 'Generation history of one installation', [idParam('id'), ...readingFilters.filter((p) => p.name !== 'installation_id'), ...paging], page('Reading')),
      post: {
        tags: ['Readings'], summary: 'Ingest a reading (device only)',
        description: 'The device authenticates as the installation (`Authorization: Device <meter_id>:<device_key>`) and may only post to its own installation. Duplicate (installation, timestamp) returns 409 so retries are safe.',
        security: [{ deviceAuth: [] }],
        parameters: [idParam('id')],
        requestBody: { required: true, content: { 'application/json': { schema: ref('ReadingInput') } } },
        responses: {
          201: { description: 'Created', headers: { Location: { schema: { type: 'string' } } }, content: { 'application/json': { schema: ref('Reading') } } },
          401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' },
          409: errRes('Duplicate reading or installation not active'), ...invalidBody,
        },
      },
    },
    '/readings': get('Readings', 'Query readings across jurisdictions (analytical)', [...readingFilters, ...paging], page('Reading')),
    '/readings/{id}': get('Readings', 'Get one reading (immutable)', [idParam('id')], one('Reading')),
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'SLSEA user token from /auth/login' },
      deviceAuth: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Format: `Device <meter_id>:<device_key>`' },
    },
    responses: {
      BadRequest: errRes('Validation error / malformed request'),
      Unauthorized: errRes('Missing or invalid credentials'),
      Forbidden: errRes('Authenticated but not permitted (wrong client type or outside jurisdiction)'),
      NotFound: errRes('Resource not found'),
      NotAcceptable: errRes('Client does not accept application/json'),
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'object' } },
              status: { type: 'integer' }, path: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      Pagination: { type: 'object', properties: { total: { type: 'integer' }, page: { type: 'integer' }, page_size: { type: 'integer' }, total_pages: { type: 'integer' } } },
      Links: { type: 'object', properties: { self: { type: 'string' }, first: { type: 'string' }, prev: { type: 'string', nullable: true }, next: { type: 'string', nullable: true }, last: { type: 'string' } } },
      Login: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', example: 'national@slsea.lk' }, password: { type: 'string' } } },
      Token: { type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string' }, expires_in: { type: 'integer' }, user: { type: 'object' } } },
      Province: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
      District: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, province_id: { type: 'integer' } } },
      Substation: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, voltage_kv: { type: 'integer' }, district_id: { type: 'integer' } } },
      Installation: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, meter_id: { type: 'string' }, name: { type: 'string' }, capacity_kw: { type: 'number' },
          status: { type: 'string', enum: ['active', 'inactive', 'decommissioned'] }, installed_on: { type: 'string', format: 'date' },
          substation_id: { type: 'integer' }, district_id: { type: 'integer' }, province_id: { type: 'integer' },
          version: { type: 'integer' }, updated_at: { type: 'string', format: 'date-time' },
        },
      },
      InstallationInput: {
        type: 'object', required: ['name', 'substation_id', 'capacity_kw', 'installed_on'],
        properties: {
          meter_id: { type: 'string', example: 'SLSEA-90001', description: 'Required on create; immutable' },
          name: { type: 'string' }, substation_id: { type: 'integer' }, capacity_kw: { type: 'number', example: 5 },
          installed_on: { type: 'string', format: 'date', example: '2026-01-15' },
          status: { type: 'string', enum: ['active', 'inactive', 'decommissioned'], default: 'active' },
        },
      },
      InstallationCreated: { allOf: [ref('Installation'), { type: 'object', properties: { device_key: { type: 'string', description: 'Shown once, for provisioning the device' } } }] },
      Reading: {
        type: 'object',
        properties: { id: { type: 'integer' }, installation_id: { type: 'integer' }, timestamp: { type: 'string', format: 'date-time' }, power_kw: { type: 'number' }, energy_kwh: { type: 'number', description: 'Cumulative' }, voltage: { type: 'number' } },
      },
      ReadingInput: {
        type: 'object', required: ['timestamp', 'power_kw', 'energy_kwh', 'voltage'],
        properties: { timestamp: { type: 'string', format: 'date-time', example: '2026-10-07T10:15:00Z' }, power_kw: { type: 'number', example: 3.42 }, energy_kwh: { type: 'number', example: 4521.8 }, voltage: { type: 'number', example: 231.4 } },
      },
      LastReading: { allOf: [ref('Reading'), { type: 'object', properties: { meter_id: { type: 'string' } } }] },
      InstallationOverview: {
        type: 'object',
        properties: { installation: ref('Installation'), location: { type: 'object' }, last_reading: { ...ref('Reading'), nullable: true }, energy_today_kwh: { type: 'number' }, total_readings: { type: 'integer' } },
      },
      GenerationSummary: {
        type: 'object',
        properties: {
          district_id: { type: 'integer' }, district_name: { type: 'string' }, as_of: { type: 'string', format: 'date-time', nullable: true }, window_minutes: { type: 'integer' },
          installations_total: { type: 'integer' }, installations_reporting: { type: 'integer' }, current_power_kw: { type: 'number' }, energy_today_kwh: { type: 'number' }, day_start: { type: 'string', nullable: true },
        },
      },
    },
  },
};
