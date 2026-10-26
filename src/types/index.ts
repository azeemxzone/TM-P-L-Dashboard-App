export type Marketplace = 'Flipkart' | 'Amazon' | 'Meesho';

export type UserRole = 'admin' | 'viewer';

export interface AllowedUserRecord {
  email: string;
  role: UserRole;
  addedAt?: string;
  addedBy?: string;
}

export interface AllowedUsersDoc {
  emails: string[];
  admins: string[];
  roles?: Record<string, UserRole>;
  users?: AllowedUserRecord[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface AppSettings {
  packing_per_dispatched_unit: number; // default 6 INR
  inbound_freight_per_purchased_unit: number; // default 5 INR
  flipkart_not_sellable_pct: number; // default 5%
  amazon_not_sellable_pct: number; // default 5%
  meesho_not_sellable_pct: number; // default 5%
  updatedAt?: string;
  updatedBy?: string;
}

export interface AuditLogItem {
  id: string;
  type: 'audit';
  setting_key: string;
  old_value: string;
  new_value: string;
  user_email: string;
  timestamp: string;
}

export interface CostMasterItem {
  id: string;
  sku_code: string;
  sku_name: string;
  weight_grams: number;
  mfg_cost: number;
  active: boolean;
  effective_from: string; // YYYY-MM-DD
  createdAt: string;
  createdBy: string;
}

export type StockEventType = 'opening' | 'purchase' | 'issue';

export interface StockEvent {
  id?: string;
  type: StockEventType | string;
  date: string; // YYYY-MM-DD
  sku_code?: string;
  qty: number;
  landed_rate?: number;
  mfg_rate?: number;
  rate?: number;
  bill_no?: string;
  is_void?: boolean;
  void?: boolean;
  void_flag?: boolean;
}

export interface WeightedAverageResult {
  avg_landed_cost: number;
  avg_mfg_cost: number;
  on_hand_qty: number;
  warnings: string[];
  avg: number;
  qty: number;
}

export interface PurchaseRow {
  id?: string;
  date: string;
  sku_code: string;
  sku_name?: string;
  qty: number;
  mfg_rate: number;
  landed_rate?: number;
  bill_no: string;
  supplier?: string;
  upload_id?: string;
  is_void?: boolean;
  void?: boolean;
  createdAt?: string;
  createdBy?: string;
}

export interface PurchaseValidationResult {
  valid: boolean;
  errors: string[];
}

export interface OpeningStockItem {
  id: string;
  sku_code: string;
  qty: number;
  mfg_rate: number;
  landed_rate?: number;
  effective_from: string; // YYYY-MM-DD
  createdAt: string;
  createdBy: string;
}

export interface PurchaseItem {
  id: string;
  date: string;
  sku_code: string;
  qty: number;
  mfg_rate: number;
  landed_rate: number;
  bill_no: string;
  supplier?: string;
  upload_id: string;
  void: boolean;
  createdAt: string;
  createdBy: string;
}

export interface PurchaseUpload {
  id: string;
  file_name: string;
  uploaded_at: string;
  user: string;
  accepted_count: number;
  rejected_count: number;
  skipped_duplicates_count: number;
  total_rows?: number;
}


