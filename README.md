# Photo Portfolio

A React photography portfolio with an Express/SQLite backend and an authenticated
admin workspace for category management, metadata editing, and queued image
uploads.

## Development

```bash
npm install
npm run build
npm test
npm start
```

The Express app runs on port 3000 by default and serves the production React
bundle from `dist/`. For frontend development, run `npm run dev` alongside
`npm start`; Vite proxies API, image, and upload requests to Express.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for production deployment and
server maintenance.
