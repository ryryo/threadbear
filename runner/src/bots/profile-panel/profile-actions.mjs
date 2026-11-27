const profileFields = new Set(['name', 'role', 'instructions']);

// The three InlineText fields from DS-Bot send one profile property at a time.
export function profileActions({ visibleProfile, callOwner, acceptProfile, report, appearance = false, enqueue = work => work() }) {
  return {
    updateBot(botId, patch) { return enqueue(async () => {
      const shown = visibleProfile();
      const fields = Object.entries(patch);
      const text = fields.length === 1 && fields.every(([key, value]) => profileFields.has(key) && typeof value === 'string');
      const avatar = appearance && fields.length > 0 && fields.every(([key]) => key === 'color' || key === 'avatar');
      if (!shown || shown.id !== botId || (!text && !avatar)) {
        report(new Error('This Bot profile field cannot be saved here.'));
        return false;
      }
      try {
        const { bot } = await callOwner(avatar ? 'bots.updateAppearance' : 'bots.update', { botId, expectedRevision: shown.revision, ...patch });
        const current = visibleProfile();
        if (current?.id === botId && current.revision <= bot.revision) acceptProfile(bot);
        return true;
      } catch (error) {
        report(error);
        return false;
      }
    }); },
  };
}
