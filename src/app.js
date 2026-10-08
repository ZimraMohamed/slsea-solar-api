import express from 'express';
import router from './routes.js';
import { ApiError, errorHandler } from './errors.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': 'max-age=15552000' });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/v1', router);

app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`)));
app.use(errorHandler);

export default app;