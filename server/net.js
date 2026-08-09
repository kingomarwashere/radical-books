// Force all outbound fetch() over IPv4. This host's IPv6 route is broken, and
// Node's fetch (undici) otherwise races/prefers IPv6 and hangs with ETIMEDOUT
// (e.g. MusicBrainz). Import this before any fetch happens.
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
