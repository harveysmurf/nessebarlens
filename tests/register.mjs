import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(new URL("./resolve-hooks.mjs", import.meta.url).pathname).href);
