import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { main_handler } = require("./src/tencent-scf.cjs");

export { main_handler };
