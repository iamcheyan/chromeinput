(function (global) {
  'use strict';
  /**
   * chromeinput 站点开关 (原 content.js 站点规则部分照抄).
   * 规则: {pattern: 正则字符串, enabled: bool}; 同 URL 多规则按最后命中生效.
   */
  const Shared = global.CIShared;
  const CI = (global.CIContent = global.CIContent || {});

  let siteRules = [];
  let currentPageEnabled = true;

  function escapeRegexLiteral(text) {
    return `${text || ''}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeSiteRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules
      .map((rule) => ({
        pattern: `${rule && rule.pattern || ''}`.trim(),
        enabled: rule ? rule.enabled !== false : true
      }))
      .filter((rule) => rule.pattern);
  }

  function getSiteRules() {
    return siteRules;
  }

  function getMatchedSiteRule(url = location.href) {
    let matchedRule = null;
    let matchedIndex = -1;
    for (let i = 0; i < siteRules.length; i++) {
      const rule = siteRules[i];
      try {
        if (new RegExp(rule.pattern).test(url)) {
          matchedRule = rule;
          matchedIndex = i;
        }
      } catch (e) {
        // 非法正则在匹配时忽略, 仅在设置界面呈现.
      }
    }
    return { rule: matchedRule, index: matchedIndex };
  }

  function evaluateCurrentPageEnabled() {
    const matched = getMatchedSiteRule();
    currentPageEnabled = matched.rule ? matched.rule.enabled !== false : true;
    if (!currentPageEnabled && CI.uiVisible) {
      global.CIEngine.state.buffer = '';
      CI.ui.hideUI();
    }
  }

  function isCurrentPageEnabled() {
    return currentPageEnabled;
  }

  async function saveSiteRules(nextRules) {
    siteRules = normalizeSiteRules(nextRules);
    evaluateCurrentPageEnabled();
    await Shared.set({ [Shared.KEYS.SITE_RULES]: siteRules });
    if (CI.uiVisible) CI.ui.renderUI();
  }

  async function upsertSiteRule(pattern, enabled) {
    await saveSiteRules([...siteRules, { pattern, enabled }]);
  }

  async function removeSiteRuleAt(index) {
    if (index < 0 || index >= siteRules.length) return;
    await saveSiteRules(siteRules.filter((_, i) => i !== index));
  }

  async function loadSiteRules() {
    const result = await Shared.get(Shared.KEYS.SITE_RULES);
    siteRules = normalizeSiteRules(result[Shared.KEYS.SITE_RULES]);
    evaluateCurrentPageEnabled();
    return siteRules;
  }

  CI.siteRules = {
    escapeRegexLiteral,
    normalizeSiteRules,
    getSiteRules,
    getMatchedSiteRule,
    evaluateCurrentPageEnabled,
    isCurrentPageEnabled,
    saveSiteRules,
    upsertSiteRule,
    removeSiteRuleAt,
    loadSiteRules
  };
})(typeof window !== 'undefined' ? window : globalThis);
