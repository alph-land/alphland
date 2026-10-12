import { readFileSync } from "fs";
import path from "path";
import type { NextApiRequest, NextApiResponse } from "next";
import { BY_ALEPHIUM_DAPPS, FEATURED_DAPPS } from "../../data/featuredDapps";

const ALL_SLUGS = Array.from(
  new Set([...BY_ALEPHIUM_DAPPS, ...FEATURED_DAPPS]),
);

interface DappListItem {
  name: string;
  developer: string;
  url: string;
}

function getDeveloperName(data: {
  name: string;
  teamInfo?: { name?: string; contactEmail?: string; anonymous?: boolean };
}): string {
  const team = data.teamInfo;
  if (team?.name) return team.name;
  return `${data.name} Team`;
}

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<DappListItem[] | { error: string }>,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const dataDir = path.join(process.cwd(), "data");
    const results: DappListItem[] = [];

    for (const slug of ALL_SLUGS) {
      try {
        const content = readFileSync(
          path.join(dataDir, `${slug}.json`),
          "utf8",
        );
        const data = JSON.parse(content);

        const website = data.links?.website;
        if (!website) continue;

        results.push({
          name: data.name,
          developer: getDeveloperName(data),
          url: website,
        });
      } catch {
        // Skip missing or malformed files
        console.warn(`dapp-list: could not load ${slug}.json`);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: "Failed to load dapp list" });
  }
}
