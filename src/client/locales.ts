export const zh = {
  title: 'YAI 额度', brand: 'YAI', remaining: '可用额度', eligible: '可使用', ineligible: '暂不可用',
  expiry: '当前订阅到期', reset: '额度重置', accessExpiry: 'CLI 权益有效至', dateLocale: 'zh-CN', validityHint: '访问有效期与订阅到期分别来自 CLI access 与 subscription summary', unknown: '未提供', loading: '正在读取…',
  paused: '已暂停更新', unavailable: '读取失败，稍后重试', auth: '需要登录或授权',
  limited: '请求受限，稍后重试', timeout: '读取超时，稍后重试', invalid: '响应数据无效',
  disabled: '账号已停用', billingUnavailable: '账单日期暂不可用',
}
export type LocaleKey = keyof typeof zh
export const en: Record<LocaleKey, string> = {
  title: 'YAI allowance', brand: 'YAI', remaining: 'Available', eligible: 'Eligible', ineligible: 'Not eligible',
  expiry: 'Current subscription expires', reset: 'Allowance reset', accessExpiry: 'CLI access valid until', dateLocale: 'en-US', validityHint: 'Access validity and subscription expiry come from CLI access and subscription summary respectively', unknown: 'Not provided', loading: 'Loading…',
  paused: 'Updates paused', unavailable: 'Unable to load; retrying later', auth: 'Sign-in or authorization required',
  limited: 'Rate limited; retrying later', timeout: 'Request timed out; retrying later', invalid: 'Invalid response data',
  disabled: 'Account disabled', billingUnavailable: 'Billing dates temporarily unavailable',
}
