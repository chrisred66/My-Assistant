-- DeepSeek prices (USD per million tokens), from https://api-docs.deepseek.com/quick_start/pricing/ (checked 2026-10-13).
--
-- These are the PEAK rates. DeepSeek charges half outside peak hours (peak = 01:00-04:00 and 06:00-10:00 UTC,
-- Monday-Friday; weekends are off-peak), so the app works out each call's exact cost when it logs it
-- (Usage::deepSeekCost) and stores it in token_usage.cost_usd. These rows are what it scales, and the fallback for
-- rows without a stored cost (e.g. manual entries), which are then priced at the peak rate.
--
-- deepseek-v4-flash is a retired name that DeepSeek still accepts and bills at the Flash price.
-- When prices change, add rows with a later effective_from; don't edit these.
INSERT INTO model_prices (provider, model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok) VALUES
    ('deepseek', 'deepseek-flash',    '2026-01-01', 0.30, 1.20, 0.006),
    ('deepseek', 'deepseek-v4-flash', '2026-01-01', 0.30, 1.20, 0.006),
    ('deepseek', 'deepseek-v4-pro',   '2026-01-01', 1.32, 3.96, 0.044);
