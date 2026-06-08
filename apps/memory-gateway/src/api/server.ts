import { buildApp } from "./app";

const PORT = Number(process.env.PORT ?? 8787);

const app = buildApp();
app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => console.log(`memories REST API listening on http://127.0.0.1:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
