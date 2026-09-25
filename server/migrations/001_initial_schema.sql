-- IndiaLock Connect POC - initial schema (TDD §7, extended for protocol evidence and auditability).
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE devices (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    terminal_id            varchar(12) UNIQUE,          -- JT/T808 header terminal ID, full 12-digit BCD form
    lock_id                varchar(8)  UNIQUE,          -- 8-digit LockID (Appendix 0)
    display_name           text,
    iccid                  varchar(32),
    imei                   varchar(32),
    firmware_version       text,
    auth_code              text,                        -- last code presented (0x0102) or issued (0x8100); length not specified
    auth_code_source       varchar(32),                 -- presented_by_device | issued_by_platform | configured
    authenticated          boolean NOT NULL DEFAULT false,
    last_auth_at           timestamptz,
    current_key            varchar(24),                 -- seal key (POC: stored in clear; see docs/DECISIONS.md)
    key_format             varchar(10) NOT NULL DEFAULT 'rf10',
    connection_status      varchar(10) NOT NULL DEFAULT 'offline',
    lock_status_code       smallint,
    lock_state             varchar(20),
    lock_status_label      text,
    lock_status_at         timestamptz,
    motor_status_code      smallint,
    battery_voltage_code   varchar(4),                  -- raw hex code, e.g. 0x35
    battery_voltage_v      numeric(3,1),
    battery_percent        smallint,
    battery_mv             integer,
    battery_at             timestamptz,
    last_seen_at           timestamptz,
    last_heartbeat_at      timestamptz,
    last_location_at       timestamptz,
    last_connected_at      timestamptz,
    last_disconnected_at   timestamptz,
    last_disconnect_reason text,
    last_remote_address    text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id         uuid REFERENCES devices(id),
    terminal_id       varchar(12),
    remote_address    text,
    remote_port       integer,
    connected_at      timestamptz NOT NULL DEFAULT now(),
    authenticated_at  timestamptz,
    disconnected_at   timestamptz,
    disconnect_reason text,
    rx_frames         integer NOT NULL DEFAULT 0,
    tx_frames         integer NOT NULL DEFAULT 0,
    rx_errors         integer NOT NULL DEFAULT 0
);
CREATE INDEX sessions_device_idx ON sessions (device_id, connected_at DESC);

CREATE TABLE message_log (
    id                bigserial PRIMARY KEY,
    created_at        timestamptz NOT NULL DEFAULT now(),
    direction         varchar(2) NOT NULL CHECK (direction IN ('rx', 'tx')),
    device_id         uuid REFERENCES devices(id),
    session_id        uuid REFERENCES sessions(id),
    terminal_id       varchar(12),
    msg_id            integer,
    msg_id_hex        varchar(6),
    msg_name          text,
    serial            integer,
    raw_hex           text NOT NULL,                    -- exactly as on the wire (escaped, with 0x7E)
    unescaped_hex     text,
    checksum_ok       boolean,
    parsed            jsonb,
    processing_result varchar(24) NOT NULL,             -- ok | invalid_frame | garbage | error | unsupported | sent
    error             text
);
CREATE INDEX message_log_device_idx ON message_log (device_id, id DESC);
CREATE INDEX message_log_session_idx ON message_log (session_id, id);

CREATE TABLE commands (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id             uuid NOT NULL REFERENCES devices(id),
    session_id            uuid REFERENCES sessions(id),
    command_type          varchar(24) NOT NULL,         -- seal | unseal | clear_alarm | ...
    cmd_code              smallint NOT NULL,            -- 0x32 / 0x38 / 0x42 ...
    lock_id               varchar(8),
    params                jsonb,                        -- request parameters (key masked)
    status                varchar(20) NOT NULL,         -- pending | sent | acknowledged | completed | rejected | timeout | send_failed
    jt808_serial          integer,                      -- serial of the 0x8900 frame
    business_serial       integer,                      -- business-layer serial echoed by the 0x55 reply
    business_tx_hex       text,
    raw_tx_hex            text,
    tx_message_log_id     bigint REFERENCES message_log(id),
    requested_at          timestamptz NOT NULL DEFAULT now(),
    sent_at               timestamptz,
    ack_at                timestamptz,
    ack_result            smallint,
    ack_result_label      varchar(32),
    replied_at            timestamptz,
    result_code           smallint,
    result_code_hex       varchar(4),
    result_label          varchar(100),
    result_meaning        text,
    outcome               varchar(12),                  -- success | no_change | failure | timeout | unknown
    reply_message_log_id  bigint REFERENCES message_log(id),
    reply_raw_hex         text,
    reply_parsed          jsonb,
    correlation_method    varchar(24),                  -- business_serial | heuristic_oldest_pending | late_business_serial
    timeout_at            timestamptz,
    error                 text,
    requested_by          text,
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commands_device_idx ON commands (device_id, requested_at DESC);
CREATE INDEX commands_business_serial_idx ON commands (device_id, business_serial);

CREATE TABLE locations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id         uuid NOT NULL REFERENCES devices(id),
    message_log_id    bigint REFERENCES message_log(id),
    source            varchar(24) NOT NULL,             -- 0x0200 | 0x0201 | 0x0900_gps
    positioned        boolean NOT NULL,
    latitude          numeric(9,6),
    longitude         numeric(9,6),
    altitude_m        integer,
    speed_kmh         numeric(6,1),
    direction_deg     smallint,
    alarm_flags       bigint,
    alarm_flags_hex   varchar(10),
    status_flags      bigint,
    status_flags_hex  varchar(10),
    lock_status_code  smallint,
    device_time       timestamptz,
    device_time_raw   varchar(12),
    received_at       timestamptz NOT NULL DEFAULT now(),
    extras            jsonb
);
CREATE INDEX locations_device_idx ON locations (device_id, received_at DESC);

CREATE TABLE alarms (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id         uuid NOT NULL REFERENCES devices(id),
    message_log_id    bigint REFERENCES message_log(id),
    source            varchar(24) NOT NULL,             -- location_alarm_flags | e7_alarm_status | lock_status | lock_upload | voltage
    alarm_type        varchar(50) NOT NULL,
    label             text,
    raw_value         text,                             -- raw bit number / code
    raw_flags_hex     varchar(16),
    raised_at         timestamptz NOT NULL,
    device_time       timestamptz,
    cleared_at        timestamptz,
    cleared_by        text,
    processing_status varchar(16) NOT NULL DEFAULT 'active',  -- active | cleared
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alarms_device_idx ON alarms (device_id, raised_at DESC);
CREATE INDEX alarms_active_idx ON alarms (device_id) WHERE cleared_at IS NULL;

-- Audit trail tables are append-only.
CREATE FUNCTION forbid_modification() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_log_append_only BEFORE UPDATE OR DELETE ON message_log
    FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER locations_append_only BEFORE UPDATE OR DELETE ON locations
    FOR EACH ROW EXECUTE FUNCTION forbid_modification();
