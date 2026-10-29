/**
 * Storefront helpers — pharmacy-side needs `fetchPharmacy` to load its
 * own catalog inside the in-chat Quote / Modify composer. Same payload
 * shape as `mobile-customer/src/lib/storefront.ts` but trimmed to what
 * the pharmacy app actually consumes.
 */
import { API_URL, session } from "@/lib/api";

export type StorefrontPharmacy = {
  id: string;
  name: string;
  business_name?: string | null;
  banner_photo_url?: string | null;
  delivery_fee: number;
};

export type StorefrontMedicine = {
  id: string;
  name: string;
  category: string;
  image_url?: string | null;
  price: number;
  stock: number;
  prescription_required?: boolean;
};

export type PharmacyDetail = {
  pharmacy: StorefrontPharmacy;
  categories: { name: string; items: StorefrontMedicine[] }[];
  total_medicines: number;
};

export async function fetchPharmacy(id: string): Promise<PharmacyDetail> {
  // The storefront endpoint 5 km-gates anonymous/customer requests, but the
  // owner pharmacy is exempted server-side — send the token so the backend
  // can recognise the owner loading their own catalog for Quote/Modify.
  const headers: HeadersInit = {};
  const token = session.access();
  if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/api/storefront/pharmacy/${id}`, { headers });
  if (!res.ok) throw new Error(`pharmacy ${res.status}`);
  return res.json();
}
