const profileFields = new Set(['name', 'role', 'instructions']);

// The three InlineText fields from DS-Bot send one profile property at a time.
export function profileActions({ visibleProfile, callOwner, acceptProfile, report }) {
  return {
    async updateBot(botId, patch) {
      const shown = visibleProfile();
      if (!shown || shown.id !== botId || Object.keys(patch).length !== 1 ||
          !Object.entries(patch).every(([key, value]) => profileFields.has(key) && typeof value === 'string')) {
        report(new Error('This Bot profile field cannot be saved here.'));
        return false;
      }
      try {
        const { bot } = await callOwner('bots.update', { botId, expectedRevision: shown.revision, ...patch });
        const current = visibleProfile();
        if (current?.id === botId && current.revision <= bot.revision) acceptProfile(bot);
        return true;
      } catch (error) {
        report(error);
        return false;
      }
    },
  };
}
