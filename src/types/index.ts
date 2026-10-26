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

export interface SkuVariantItem {
  id: string;
  variant_sku: string;
  master_sku: string;
  active: boolean;
  createdAt: string;
  createdBy: string;
}
