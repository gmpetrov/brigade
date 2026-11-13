/** Directories whose free listing asks for a link back from this site, shown in one quiet
 * line of the landing page's footer, after There's An AI For That's badge. They are
 * temporary: once each directory has checked its link and listed Brigade, remove its entry
 * (the line goes away with the last one).
 *
 * Their checks look for a plain, followed link to the address given here (no
 * rel="nofollow"), so keep each href as the directory asked for it. AI Agents Directory
 * only accepts its own badge image, so that one is drawn as the badge. */
export type FeaturedOn = {
  name: string
  href: string
  badge?: { src: string; alt: string; width: number; height: number }
}

export const FEATURED_ON: FeaturedOn[] = [
  { name: 'Dang.ai', href: 'https://dang.ai' },
  { name: 'Twelve Tools', href: 'https://twelve.tools' },
  { name: 'AgentHunter', href: 'https://www.agenthunter.io' },
  { name: 'ToolPilot', href: 'https://www.toolpilot.ai' },
  {
    name: 'AI Agents Directory',
    href: 'https://aiagentsdirectory.com/agent/brigade',
    badge: {
      src: 'https://aiagentsdirectory.com/featured-badge.svg?v=2024',
      alt: 'Brigade - Featured on AI Agents Directory',
      width: 200,
      height: 50,
    },
  },
]
