declare module "node:fs" {
  export function readdirSync(dir: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
}
