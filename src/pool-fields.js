// Credit-pool field map for the bridge (mirrors web/utils/credits/pool-fields.js).
// Two ledgers live on orgs/{orgId}: AI credits and cataloguing credits. Pipeline tools
// (cataloguing, product_photoshoot) may bill against EITHER; the task doc carries the
// chosen pool as `credit_pool` (set by the submit route from extra_params.credit_type).

export const CREDIT_POOLS = {
  credits: {
    balance: 'credits',
    reserved: 'reserved_credits',
    used: 'credits_used',
    history: 'credit_history',
    subEnd: 'subscription_end_date',
    supportsUnlimited: true,
    perUserUsed: 'credits_used', // org_users/{uid} tracks AI usage only
  },
  cataloguing_credits: {
    balance: 'cataloguing_credits',
    reserved: 'reserved_cataloguing_credits',
    used: 'cataloguing_credits_used',
    history: 'cataloguing_credit_history',
    subEnd: 'cataloguing_subscription_end_date',
    supportsUnlimited: false,
    perUserUsed: null, // no per-user cataloguing limit today
  },
};

export function normalizePool(pool) {
  return pool === 'cataloguing_credits' ? 'cataloguing_credits' : 'credits';
}

export function poolFields(pool) {
  return CREDIT_POOLS[normalizePool(pool)] || CREDIT_POOLS.credits;
}
