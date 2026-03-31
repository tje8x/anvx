CREATE TABLE events (
	id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
	event_type TEXT NOT NULL,
	event_category TEXT,
	surface TEXT NOT NULL,
	session_id TEXT,
	metadata JSONB DEFAULT '{}',
	created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_type ON events(event_type, created_at);
CREATE INDEX idx_events_surface ON events(surface, created_at);
