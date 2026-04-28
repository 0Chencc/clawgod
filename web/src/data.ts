// Single source of truth for the patches displayed on the page.
// Keep wording terse — these render inside ~260px-wide cards.

export type PatchKind = 'unlock' | 'remove' | 'visual' | 'route';

export interface Patch {
  kind: PatchKind;
  name: string;
  desc: string;
}

export interface Section {
  num: string;
  title: string;
  blurb: string;
  patches: Patch[];
}

export const sections: Section[] = [
  {
    num: '01',
    title: 'Feature unlocks',
    blurb: 'Internal-only commands and gates flipped to enabled.',
    patches: [
      { kind: 'unlock', name: 'Internal user mode',  desc: '24+ hidden commands, debug logging, API request dumps.' },
      { kind: 'unlock', name: 'GrowthBook overrides', desc: 'Override any feature flag from a config file.' },
      { kind: 'unlock', name: 'Agent Teams',          desc: 'Multi-agent swarm collaboration without flags.' },
      { kind: 'unlock', name: 'Computer Use',         desc: 'Screen control without the Max/Pro subscription gate.' },
      { kind: 'unlock', name: 'Ultraplan',            desc: 'Web-side multi-agent planning via Claude Code Remote.' },
      { kind: 'unlock', name: 'Ultrareview',          desc: 'Automated bug-hunter review via Claude Code Remote.' },
      { kind: 'unlock', name: 'Voice Mode',           desc: 'Built-in voice dictation, no kill-switch.' },
      { kind: 'unlock', name: 'Auto-mode third-party', desc: 'Auto-mode unlocked for non-Anthropic API endpoints.' },
    ],
  },
  {
    num: '02',
    title: 'Restriction removals',
    blurb: 'System prompt instructions stripped at patch time.',
    patches: [
      { kind: 'remove', name: 'CYBER_RISK_INSTRUCTION', desc: 'Security testing refusal — pentest, C2, exploits.' },
      { kind: 'remove', name: 'URL guess restriction',  desc: '"NEVER generate or guess URLs" instruction.' },
      { kind: 'remove', name: 'Cautious actions',       desc: 'Forced confirmation before destructive operations.' },
      { kind: 'remove', name: 'Login notice',           desc: '"Not logged in" startup banner.' },
      { kind: 'remove', name: 'Attachment filter',      desc: 'Internal attachment-type gating bypass.' },
      { kind: 'remove', name: 'Message filter',         desc: 'Reveal content normally hidden from external users.' },
    ],
  },
  {
    num: '03',
    title: 'Visual',
    blurb: 'A single signal that you are running the patched build.',
    patches: [
      { kind: 'visual', name: 'Green theme',  desc: 'Brand color → green. Patched at a glance.' },
      { kind: 'visual', name: 'ANSI palette', desc: 'Logo, shimmer, prompts — all green-tinted.' },
    ],
  },
  {
    num: '04',
    title: 'Routing',
    blurb: 'Upgrade flow that survives Anthropic\'s bun-runtime swaps.',
    patches: [
      { kind: 'route', name: 'claude update redirect', desc: '`claude update` routes through clawgod\'s installer — pulls latest Anthropic release + re-patches in one step.' },
    ],
  },
];
