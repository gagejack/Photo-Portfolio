import express from 'express';
import session from 'express-session';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicRouter } from './routes/public.js';
import { authRouter, requireAuth } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { sweepStaging } from './images/pipeline.js';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1); // behind the Cloudflare tunnel

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  }));

  // Anything left in staging belongs to a queue that died with the last
  // process. Clear it before serving.
  const swept = sweepStaging(config.photosRoot);
  if (swept > 0) console.log(`swept ${swept} orphaned staging file(s)`);

  // Only derivatives are exposed. `originals/` is deliberately not served.
  app.use('/photos/thumb', express.static(join(config.photosRoot, 'thumb')));
  app.use('/photos/display', express.static(join(config.photosRoot, 'display')));

  app.use(authRouter(config));
  app.use(adminRouter({ db, config }));
  app.use(publicRouter({ db, config }));

  const sendReactApp = (req, res) => {
    res.sendFile(join(APP_ROOT, 'dist', 'index.html'));
  };
  app.use(express.static(join(APP_ROOT, 'dist'), { index: false }));
  app.get('/admin', requireAuth, sendReactApp);
  app.get('/admin/login', (req, res) => {
    if (req.session?.user) return res.redirect('/admin');
    return sendReactApp(req, res);
  });
  app.get(['/', '/c/:slug', '/more'], sendReactApp);

  return app;
}
