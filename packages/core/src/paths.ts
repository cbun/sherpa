import path from "node:path";

export function resolveSherpaPaths(rootDir: string) {
  return {
    rootDir,
    eventsDir: path.join(rootDir, "events"),
    graphPath: path.join(rootDir, "graph.sqlite")
  };
}
