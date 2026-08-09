// Funny profile avatars. We use DiceBear's cartoon styles (free, no hosting —
// just SVG URLs), so the gallery is "seeded" with a spread of goofy characters.
// Every user gets a unique funny default derived from their username; picking
// from the gallery overrides it.
const D = (style, seed, extra = '') =>
  `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}${extra}`;

// A curated gallery of funny avatars across several playful styles.
export const AVATAR_PRESETS = [
  D('fun-emoji', 'Banana'),   D('fun-emoji', 'Pickle'),   D('fun-emoji', 'Gizmo'),    D('fun-emoji', 'Waffles'),
  D('bottts',    'Clanky'),   D('bottts',    'Sprocket'), D('bottts',    'Zappy'),     D('bottts',    'Boop'),
  D('thumbs',    'Goober'),   D('thumbs',    'Noodle'),   D('thumbs',    'Spud'),       D('thumbs',    'Biscuit'),
  D('big-smile', 'Sunny'),    D('big-smile', 'Peaches'),  D('big-smile', 'Mango'),      D('big-smile', 'Waldo'),
  D('croodles',  'Doodle'),   D('croodles',  'Squiggle'), D('croodles',  'Scribble'),   D('croodles',  'Pretzel'),
  D('adventurer','Pumpkin'),  D('adventurer','Bubbles'),  D('open-peeps','Giggles'),    D('personas', 'Rascal'),
];

const PRESET_SET = new Set(AVATAR_PRESETS);

// Deterministic funny default so everyone has an avatar out of the box.
export function defaultAvatarFor(username) {
  return D('fun-emoji', username || 'sound');
}

// The avatar to actually display for a user row (chosen preset, or their default).
export function resolveAvatar(user) {
  return (user && user.avatar) || defaultAvatarFor(user && user.username);
}

// Only allow avatars from our gallery (prevents arbitrary URLs in <img src>).
export function isValidAvatar(url) {
  return typeof url === 'string' && PRESET_SET.has(url);
}
