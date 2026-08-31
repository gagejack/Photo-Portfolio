import express from 'express';
import session from 'express-session';
import { join } from 'node:path';
import { publicRouter } from './routes/public.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { sweepStaging } from './images/pipeline.js';

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1); // behind the Cloudflare tunnel

  app.use(express.urlencoded({ extended: false }));
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

  app.use(express.static('public'));

  // Anything left in staging belongs to a queue that died with the last
  // process. Clear it before serving.
  const swept = sweepStaging(config.photosRoot);
  if (swept > 0) console.log(`swept ${swept} orphaned staging file(s)`);

  // Only derivatives are exposed. `originals/` is deliberately not served.
  app.use('/photos/thumb', express.static(join(config.photosRoot, 'thumb')));
  app.use('/photos/display', express.static(join(config.photosRoot, 'display')));

  app.use(authRouter(config));
  app.use(adminRouter({ db, config }));
  app.use(publicRouter(db));

  return app;
}
