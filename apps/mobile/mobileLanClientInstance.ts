import { createMobileLanClient } from './mobileLanClient';
import { secureLanUrl } from './mobileSecureTransport';

export const mobileLanClient = createMobileLanClient((input, init) => fetch(secureLanUrl(input), init));
