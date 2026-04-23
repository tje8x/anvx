create table models (
	provider text not null,
	model text not null,
	pool_hint text, 					-- 'chat-fast' | 'chat-quality' | 'reasoning' | 'embedding'
	input_price_per_mtok_cents int,		-- per million tokens, in cents USD
	output_price_per_mtok_cents int,
	context_window int,
	updated_at timestamptz default now() not null,
	primary key (provider, model)
);

-- No RLS — this is public reference data, all workspaces read it identically.