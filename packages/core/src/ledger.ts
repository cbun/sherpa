import fs from "node:fs/promises";
import path from "node:path";

import { SherpaEventSchema, type SherpaEvent, type SherpaEventInput } from "./types.js";

export async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function appendEvent(eventsDir: string, eventInput: SherpaEventInput): Promise<SherpaEvent> {
  const event = SherpaEventSchema.parse(eventInput);
  await ensureDir(eventsDir);

  const dateShard = `${event.ts.slice(0, 10)}.jsonl`;
  const shardPath = path.join(eventsDir, dateShard);

  await fs.appendFile(shardPath, `${JSON.stringify(event)}\n`, "utf8");

  return event;
}

export async function readLedger(eventsDir: string): Promise<SherpaEvent[]> {
  try {
    const entries = await fs.readdir(eventsDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();

    const events: SherpaEvent[] = [];

    for (const file of files) {
      const content = await fs.readFile(path.join(eventsDir, file), "utf8");
      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        events.push(SherpaEventSchema.parse(JSON.parse(line)));
      }
    }

    return events.sort((left, right) => {
      if (left.caseId !== right.caseId) {
        return left.caseId.localeCompare(right.caseId);
      }

      if (left.ts !== right.ts) {
        return left.ts.localeCompare(right.ts);
      }

      return left.eventId.localeCompare(right.eventId);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
