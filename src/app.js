// src/app.js
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import router from './routes.js';
import openapi from './openapi.js';
import { ApiError, errorHandler } from './errors.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': 'max-age=15552000' });
  next();
});

app.get('/', (req, res) => res.redirect('/docs'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/openapi.json', (req, res) => res.json(openapi));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'SLSEA Solar Generation API' }));
app.use('/api/v1', router);

app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`)));
app.use(errorHandler);

export default app;