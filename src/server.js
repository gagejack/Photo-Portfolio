import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, config });

app.listen(config.port, config.host, () => {
  console.log(`Listening on http://${config.host}:${config.port}`);
});
