function required(env, key) {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

export function loadConfig(env = process.env) {
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return {
    port: Number(env.PORT ?? 3000),
    host: '127.0.0.1',
    dbPath: required(env, 'DB_PATH'),
    photosRoot: required(env, 'PHOTOS_ROOT'),
    sessionSecret,
    adminUser: required(env, 'ADMIN_USER'),
    adminHash: required(env, 'ADMIN_PASSWORD_HASH'),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  };
}
