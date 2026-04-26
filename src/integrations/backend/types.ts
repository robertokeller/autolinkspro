export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type RowBase = Record<string, unknown>;

type TableDef<Row extends RowBase> = {
  Row: Row;
  Insert: Partial<Row> & RowBase;
  Update: Partial<Row> & RowBase;
  Relationships: [];
};

type TableMap = {
  admin_audit_logs: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    action: string;
    target_user_id: string | null;
    details: Json;
  }>;
  api_credentials: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    provider: string;
    app_id: string;
    secret_key: string;
    region: string;
  }>;
  api_credentials_safe: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    provider: string;
    app_id: string;
    region: string;
  }>;
  cta_ai_generation_logs: TableDef<{
    id: string;
    user_id: string;
    template_id: string | null;
    tone_key: string;
    offer_title: string;
    generated_phrase: string;
    provider: string;
    model: string;
    status: "success" | "fallback" | "error";
    latency_ms: number | null;
    error_message: string | null;
    created_at: string;
  }>;
  cta_ai_tones: TableDef<{
    key: string;
    label: string;
    description: string;
    system_prompt: string;
    sort_order: number;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>;
  cta_random_phrases: TableDef<{
    id: string;
    phrase: string;
    sort_order: number;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>;
  groups: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    platform: string;
    invite_link: string;
    session_id: string | null;
    member_count: number;
    external_id: string | null;
    is_admin: boolean;
    owner_jid: string;
    invite_code: string;
    deleted_at: string | null;
  }>;
  history_entries: TableDef<{
    id: string;
    created_at: string;
    user_id: string;
    type: string;
    source: string;
    destination: string;
    status: string;
    details: Json;
    direction: string;
    message_type: string;
    processing_status: string;
    block_reason: string;
    error_step: string;
  }>;
  history_entry_targets: TableDef<{
    id: string;
    created_at: string;
    history_entry_id: string;
    user_id: string;
    destination_group_id: string | null;
    destination: string;
    platform: string;
    status: string;
    processing_status: string;
    block_reason: string;
    error_step: string;
    message_type: string;
    send_order: number;
    provider_message_id: string | null;
    delivery_status: string | null;
    delivery_updated_at: string | null;
    delivery_error: string | null;
    delivery_metadata: Json;
    details: Json;
  }>;
  link_hub_pages: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    slug: string;
    title: string;
    is_active: boolean;
    config: Json;
  }>;
  master_group_links: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    master_group_id: string;
    group_id: string;
    is_active: boolean;
  }>;
  master_groups: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    slug: string | null;
    distribution: string;
    member_limit: number;
  }>;
  meli_sessions: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    account_name: string;
    ml_user_id: string;
    status: string;
    last_checked_at: string | null;
    error_message: string;
  }>;
  meli_vitrine_products: TableDef<{
    id: string;
    tab_key: string;
    source_url: string;
    product_url: string;
    title: string;
    image_url: string;
    price_cents: number;
    old_price_cents: number | null;
    discount_text: string;
    seller: string;
    rating: number | null;
    reviews_count: number | null;
    shipping_text: string;
    installments_text: string;
    badge_text: string;
    payload_hash: string;
    is_active: boolean;
    first_seen_at: string;
    last_seen_at: string;
    collected_at: string;
    created_at: string;
    updated_at: string;
  }>;
  meli_vitrine_sync_runs: TableDef<{
    id: string;
    source: string;
    status: string;
    message: string;
    scanned_tabs: number;
    fetched_cards: number;
    added_count: number;
    updated_count: number;
    removed_count: number;
    unchanged_count: number;
    started_at: string;
    finished_at: string | null;
    created_at: string;
  }>;
  profiles: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    email: string;
    plan_id: string;
    plan_expires_at: string | null;
    phone: string;
    notification_prefs: Json;
  }>;
  system_announcements: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    created_by_user_id: string;
    title: string;
    message: string;
    severity: string;
    channel: string;
    auto_popup_on_login: boolean;
    starts_at: string | null;
    ends_at: string | null;
    is_active: boolean;
    target_filter: Json;
  }>;
  user_notifications: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    announcement_id: string;
    status: string;
    read_at: string | null;
    dismissed_at: string | null;
    delivered_at: string;
  }>;
  user_cta_random_state: TableDef<{
    user_id: string;
    last_phrase_id: string | null;
    recent_phrase_ids: string[];
    created_at: string;
    updated_at: string;
  }>;
  user_personalized_ctas: TableDef<{
    id: string;
    user_id: string;
    phrase: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>;
  user_template_cta_ai_config: TableDef<{
    id: string;
    user_id: string;
    template_id: string;
    tone_key: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>;
  app_runtime_flags: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    maintenance_enabled: boolean;
    maintenance_title: string;
    maintenance_message: string;
    maintenance_eta: string | null;
    allow_admin_bypass: boolean;
    updated_by_user_id: string;
  }>;
  system_settings: TableDef<{
    key: string;
    value: Json;
    updated_at: string;
  }>;
  route_destinations: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    route_id: string;
    group_id: string;
  }>;
  routes: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    source_group_id: string;
    status: string;
    rules: Json;
  }>;
  scheduled_post_destinations: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    post_id: string;
    group_id: string;
  }>;
  scheduled_posts: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    content: string;
    scheduled_at: string;
    recurrence: string;
    status: string;
    metadata: Json;
  }>;
  shopee_automations: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    interval_minutes: number;
    min_discount: number;
    min_commission: number;
    min_price: number;
    max_price: number;
    categories: string[] | null;
    destination_group_ids: string[] | null;
    master_group_ids: string[];
    template_id: string | null;
    session_id: string | null;
    active_hours_start: string;
    active_hours_end: string;
    products_sent: number;
    last_run_at: string | null;
    is_active: boolean;
    config: Json;
  }>;
  shopee_sub_ids: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    value: string;
    is_default: boolean;
  }>;
  telegram_sessions: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    phone: string;
    status: string;
    connected_at: string | null;
    error_message: string;
    phone_code_hash: string;
    session_string: string;
  }>;
  templates: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    content: string;
    category: string;
    scope: string;
    tags: string[];
    is_default: boolean;
  }>;
  whatsapp_sessions: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    name: string;
    phone: string;
    status: string;
    is_default: boolean;
    auth_method: string;
    qr_code: string;
    error_message: string;
    connected_at: string | null;
    microservice_url: string;
  }>;
  user_roles: TableDef<{
    id: string;
    created_at: string;
    updated_at: string;
    user_id: string;
    role: "admin" | "user";
  }>;
};

type Database = {
  public: {
    Tables: TableMap;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      app_role: "admin" | "user";
    };
    CompositeTypes: Record<string, never>;
  };
};

type PublicSchema = Database["public"];

type PublicRelationName = keyof (PublicSchema["Tables"] & PublicSchema["Views"]);

export type Tables<
  PublicTableNameOrOptions extends PublicRelationName | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : PublicTableNameOrOptions extends PublicRelationName
    ? (PublicSchema["Tables"] & PublicSchema["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;
