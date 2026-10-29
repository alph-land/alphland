/**
 * AUTO-GENERATED — do not edit by hand.
 * Run `node scripts/generate-dapp-list.js` (or `npm run generate-dapp-list`) to regenerate.
 * Source of truth: src/data/featuredDapps.ts
 */

import alephiumBridge from "../../data/alephium-bridge.json";
import alephiumExplorer from "../../data/alephium-explorer.json";
import alephiumOfficialWallets from "../../data/alephium-official-wallets.json";
import powfi from "../../data/powfi.json";
import alphpad from "../../data/alphpad.json";
import alph2048Arena from "../../data/alph-2048-arena.json";
import aura from "../../data/aura.json";
import alphscoundrel from "../../data/alphscoundrel.json";
import deadrare from "../../data/deadrare.json";
import dia from "../../data/dia.json";
import elexium from "../../data/elexium.json";
import henrycoder from "../../data/henrycoder.json";
import learnify from "../../data/learnify.json";
import ledgerWallet from "../../data/ledger-wallet.json";
import linxApp from "../../data/linx-app.json";
import moonshotboxes from "../../data/moonshotboxes.json";
import nightshade from "../../data/nightshade.json";
import onekeyWallet from "../../data/onekey-wallet.json";
import alephiumFlippers from "../../data/alephium-flippers.json";
import safepalWallet from "../../data/safepal-wallet.json";
import tangemWallet from "../../data/tangem-wallet.json";
import alephiumDetectives from "../../data/alephium-detectives.json";
import presenceprotocol from "../../data/presenceprotocol.json";
import chainReaction from "../../data/chain-reaction.json";

export interface DappData {
  name: string;
  description?: string;
  short_description?: string;
  tags?: string[];
  councils_choice?: boolean;
  verified?: boolean;
  dotw?: boolean;
  links?: {
    website?: string;
    careers?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    github?: string;
    youtube?: string;
    medium?: string;
    mirror?: string;
    linkedin?: string;
    docs?: string;
  };
  teamInfo?: {
    name?: string;
    contactEmail?: string;
    anonymous?: boolean;
    founded?: string;
  };
  media?: {
    logoUrl?: string;
    bannerUrl?: string;
    previewUrl?: string;
    videoUrl?: string;
    gallery?: unknown[];
  };
  contracts?: unknown[];
  audits?: unknown[];
  tokens?: unknown[];
  nft?: unknown;
  twitterName?: string;
  group?: string;
}

interface DappListItem {
  name: string;
  developer: string;
  url: string;
}

function getDeveloperName(data: DappData): string {
  const team = data.teamInfo;
  if (team?.name) return team.name;
  return `${data.name} Team`;
}

const RAW: DappData[] = [
  // By Alephium
  alephiumBridge,
  alephiumExplorer,
  alephiumOfficialWallets,
  powfi,
  // Spotlight
  alphpad,
  alph2048Arena,
  aura,
  alphscoundrel,
  deadrare,
  dia,
  elexium,
  henrycoder,
  learnify,
  ledgerWallet,
  linxApp,
  moonshotboxes,
  nightshade,
  onekeyWallet,
  alephiumFlippers,
  safepalWallet,
  tangemWallet,
  alephiumDetectives,
  presenceprotocol,
  chainReaction,
];

const seen = new Set<string>();
const DEDUPED = RAW.filter((raw) => {
  if (seen.has(raw.name)) return false;
  seen.add(raw.name);
  return true;
});

// Simple list: name + developer + url (for Apple App Store compliance)
export const DAPP_LIST: DappListItem[] = DEDUPED.reduce<DappListItem[]>(
  (acc, raw) => {
    const url = raw.links?.website;
    if (url)
      acc.push({ name: raw.name, developer: getDeveloperName(raw), url });
    return acc;
  },
  [],
);
