/**
 * Labeled concept set for the style-alignment decision (text-only, Jev's
 * natural fit). `aligned` is the ground truth under BRAND_VOICE /
 * CONCEPT_RULES / ART_RULES: good ones are written to follow the rules,
 * bad ones each break exactly one clearly stated rule.
 */
export interface StyleCase {
  id: string;
  phrase: string;
  visualConcept: string;
  backPhrase: string | null;
  aligned: boolean;
  violates?: string;
}

const ok = (id: string, phrase: string, visualConcept: string, backPhrase: string | null): StyleCase => ({
  id,
  phrase,
  visualConcept,
  backPhrase,
  aligned: true,
});
const bad = (id: string, violates: string, phrase: string, visualConcept: string, backPhrase: string | null): StyleCase => ({
  id,
  phrase,
  visualConcept,
  backPhrase,
  aligned: false,
  violates,
});

export const STYLE_CASES: StyleCase[] = [
  ok("ok-1", "Read the Room", "A bold open book with a speech bubble of ellipsis dots, flat streetwear graphic.", "You Weren't Reading It Anyway"),
  ok("ok-2", "Main Character", "A clapperboard with a crown on top, clean line art, two-color palette.", "Exit, Stage Main Character"),
  ok("ok-3", "Sent on Read", "Two checkmarks inside a broken heart, street-art stencil style.", "No Reply Necessary"),
  ok("ok-4", "Spill It", "An overflowing teacup with steam shaped like a gossip speech bubble, minimal flat art.", "More Tea Behind Me"),
  ok("ok-5", "Reply All Regret", "A cartoon envelope sweating nervously with tiny arrows spiraling out, badge layout.", "Recall Failed"),
  ok("ok-6", "Seen 3:47 AM", "A glowing phone screen with a single lonely read receipt, high-contrast stencil.", "Still Awake, Still Waiting"),
  ok("ok-7", "Group Chat Muted", "A speech bubble wearing a tiny eye mask, asleep, line art.", "Notifications: 99+ Regrets"),
  ok("ok-8", "Per My Last Email", "A fountain pen stabbing through a paper plane, sharp editorial linework.", "Kindly Disregard This Too"),
  ok("ok-9", "Plot Twist", "A cracked mug with a question mark leaking out of it, bold emblem.", "Spoiler: It Was You"),
  ok("ok-10", "Not Your Therapist", "A cartoon couch with a No symbol over it, thick outlines, two-tone.", "Venting Hours Are Over"),
  ok("ok-11", "Hot Take Served", "A steaming bowl labeled with a flame-shaped speech bubble, retro badge.", "Reheated From Last Week"),
  ok("ok-12", "Left on Delivered", "A paper boat drifting away from a message bubble on a calm line-art sea.", "Bon Voyage, Unread"),
  bad("bad-1", "phrase too long (over ~32 chars / 2-5 words)", "I Cannot Believe You Actually Posted That Photo Online", "A shocked face emoji style cartoon with sweat drops.", "Believe It"),
  bad("bad-2", "emoji in phrase", "Tea Time ☕🔥", "A teacup with steam, flat vector art.", "Sip Sip"),
  bad("bad-3", "hashtag in phrase", "#SpillTheTea", "A teacup tipping over, bold lines.", "Hashtag Blessed"),
  bad("bad-4", "copied brand slogan", "Just Do It", "A running shoe silhouette with the Nike swoosh logo on it.", "Do It Again"),
  bad("bad-5", "copied song lyric", "Never Gonna Give You Up", "A rolled-up vinyl record with notes, retro style.", "Never Gonna Let You Down"),
  bad("bad-6", "real celebrity name used", "Taylor Swift Is Watching", "A realistic portrait of Taylor Swift holding a teacup.", "She Knows"),
  bad("bad-7", "backPhrase just repeats the front phrase", "Spill It", "An overflowing teacup with gossip bubble steam, minimal flat art.", "Spill It"),
  bad("bad-8", "visualConcept not concretely drawable", "Vibes Only", "The feeling of nostalgia mixed with the concept of tomorrow.", "Good Vibes"),
  bad("bad-9", "non-ASCII characters in phrase", "Té Délicieux ☀ 紅茶", "A teacup with steam, minimal flat art.", "Merci"),
  bad("bad-10", "visualConcept instructs recreating a copyrighted character", "Cat Gossip", "Recreate Garfield exactly as in the comic, holding a teacup.", "Lasagna Later"),
  bad("bad-11", "visualConcept instructs adding a watermark/signature", "Mic Drop", "A microphone falling with a speech bubble; add a signature in the corner and a 'wearthistea.com' watermark.", "Pick It Up"),
  bad("bad-12", "copied meme caption", "One Does Not Simply Walk Into Mordor", "Boromir meme screenshot style with impact font top and bottom text.", "Simply Not"),
];
