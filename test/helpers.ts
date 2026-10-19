import { profileDefaults } from '../src/config/profiles.js';
import type { Profile } from '../src/config/schema.js';

export const ctx = {
  hasGitHub: true,
  baseBranch: 'main',
  identity: { name: 'Ada', email: 'ada@example.com' },
  projectId: '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f',
  packageVersion: '0.1.0',
};
export const defaults = (p: Profile = 'project-owner', c = ctx) => profileDefaults(p, c).config;
