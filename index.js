import fs from "fs";
import Database from "better-sqlite3";
import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const rawConfig = JSON.parse(fs.readFileSync("./config.json", "utf8"));

const config = {
  botToken: process.env.BOT_TOKEN || rawConfig.botToken,
  guildId: process.env.GUILD_ID || rawConfig.guildId,
  ticketPrefix: process.env.TICKET_PREFIX || rawConfig.ticketPrefix,
  staffRoleIds: rawConfig.staffRoleIds || [],
  alerts: {
    staffRoleToDmId: process.env.STAFF_ALERT_ROLE_ID || rawConfig.alerts?.staffRoleToDmId,
    ownerUserId: process.env.OWNER_USER_ID || rawConfig.alerts?.ownerUserId,
    staffAlertHours: Number(process.env.STAFF_ALERT_HOURS || rawConfig.alerts?.staffAlertHours || 8),
    ownerAlertHours: Number(process.env.OWNER_ALERT_HOURS || rawConfig.alerts?.ownerAlertHours || 24),
  },
  scan: {
    intervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || rawConfig.scan?.intervalMinutes || 5),
  },
  branding: {
    footerText: rawConfig.branding?.footerText || "Bot made by tanner.fps",
    staffEmbedColor: rawConfig.branding?.staffEmbedColor || "#F59E0B",
    ownerEmbedColor: rawConfig.branding?.ownerEmbedColor || "#EF4444",
  },
};

if (!config.botToken) {
  throw new Error("Missing bot token. Put it in config.json or set BOT_TOKEN in the host.");
}

if (!config.guildId) {
  throw new Error("Missing guildId in config.json or environment variables.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const db = new Database("tickets.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_state (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    waiting_on_staff INTEGER NOT NULL DEFAULT 0,
    last_user_message_at INTEGER,
    last_staff_message_at INTEGER,
    alerted_staff INTEGER NOT NULL DEFAULT 0,
    alerted_owner INTEGER NOT NULL DEFAULT 0,
    last_nonstaff_user_id TEXT,
    updated_at INTEGER NOT NULL
  )
`);

const upsertTicket = db.prepare(`
  INSERT INTO ticket_state (
    channel_id, guild_id, waiting_on_staff, last_user_message_at, last_staff_message_at,
    alerted_staff, alerted_owner, last_nonstaff_user_id, updated_at
  ) VALUES (
    @channel_id, @guild_id, @waiting_on_staff, @last_user_message_at, @last_staff_message_at,
    @alerted_staff, @alerted_owner, @last_nonstaff_user_id, @updated_at
  )
  ON CONFLICT(channel_id) DO UPDATE SET
    guild_id = excluded.guild_id,
    waiting_on_staff = excluded.waiting_on_staff,
    last_user_message_at = excluded.last_user_message_at,
    last_staff_message_at = excluded.last_staff_message_at,
    alerted_staff = excluded.alerted_staff,
    alerted_owner = excluded.alerted_owner,
    last_nonstaff_user_id = excluded.last_nonstaff_user_id,
    updated_at = excluded.updated_at
`);

const getTicket = db.prepare(`SELECT * FROM ticket_state WHERE channel_id = ?`);
const getAllWaiting = db.prepare(`SELECT * FROM ticket_state WHERE waiting_on_staff = 1`);
const deleteTicket = db.prepare(`DELETE FROM ticket_state WHERE channel_id = ?`);

function isTicketChannel(channel) {
  return (
    channel &&
    channel.type === ChannelType.GuildText &&
    typeof channel.name === "string" &&
    channel.name.toLowerCase().startsWith(String(config.ticketPrefix).toLowerCase())
  );
}

function memberIsStaff(member) {
  if (!member) return false;
  return config.staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function nowMs() {
  return Date.now();
}

function ticketLink(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function buildStaffEmbed(channel, state) {
  const waitedMs = nowMs() - state.last_user_message_at;
  return new EmbedBuilder()
    .setColor(config.branding.staffEmbedColor)
    .setTitle("Unanswered Ticket Alert")
    .setDescription("A ticket is still waiting on a staff response.")
    .addFields(
      { name: "Ticket Channel", value: `#${channel.name}`, inline: true },
      { name: "Waiting Time", value: formatDuration(waitedMs), inline: true },
      { name: "Last User ID", value: state.last_nonstaff_user_id || "Unknown", inline: true },
      { name: "Jump to Ticket", value: ticketLink(channel.guild.id, channel.id), inline: false },
      { name: "Status", value: "The most recent tracked message came from a non-staff user.", inline: false },
    )
    .setTimestamp(new Date())
    .setFooter({ text: config.branding.footerText });
}

function buildOwnerEmbed(channel, state) {
  const waitedMs = nowMs() - state.last_user_message_at;
  const extraWaitMs = Math.max(
    0,
    (config.alerts.ownerAlertHours - config.alerts.staffAlertHours) * 60 * 60 * 1000
  );

  return new EmbedBuilder()
    .setColor(config.branding.ownerEmbedColor)
    .setTitle("Ticket Escalation Alert")
    .setDescription("This ticket still has not been answered after the staff alert already went out.")
    .addFields(
      { name: "Ticket Channel", value: `#${channel.name}`, inline: true },
      { name: "Total Waiting Time", value: formatDuration(waitedMs), inline: true },
      {
        name: "Prior Staff Alert",
        value: `Staff was already alerted ${formatDuration(extraWaitMs)} ago and the ticket is still unanswered.`,
        inline: false,
      },
      { name: "Last User ID", value: state.last_nonstaff_user_id || "Unknown", inline: true },
      { name: "Jump to Ticket", value: ticketLink(channel.guild.id, channel.id), inline: false },
    )
    .setTimestamp(new Date())
    .setFooter({ text: config.branding.footerText });
}

async function safeSendDM(user, payload) {
  try {
    await user.send(payload);
    return true;
  } catch (err) {
    console.warn(`DM failed for user ${user?.id}: ${err.message}`);
    return false;
  }
}

async function sendStaffAlerts(guild, channel, state) {
  await guild.members.fetch();

  const role = await guild.roles.fetch(config.alerts.staffRoleToDmId).catch(() => null);
  if (!role) {
    console.warn(`Staff alert role not found: ${config.alerts.staffRoleToDmId}`);
    return;
  }

  const embed = buildStaffEmbed(channel, state);
  const members = role.members.filter((member) => !member.user.bot);

  for (const [, member] of members) {
    await safeSendDM(member.user, { embeds: [embed] });
  }
}

async function sendOwnerAlert(channel, state) {
  const owner = await client.users.fetch(config.alerts.ownerUserId).catch(() => null);
  if (!owner) {
    console.warn(`Owner user not found: ${config.alerts.ownerUserId}`);
    return;
  }

  const embed = buildOwnerEmbed(channel, state);
  await safeSendDM(owner, { embeds: [embed] });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const rows = getAllWaiting.all();
    const staffThresholdMs = config.alerts.staffAlertHours * 60 * 60 * 1000;
    const ownerThresholdMs = config.alerts.ownerAlertHours * 60 * 60 * 1000;
    const currentTime = nowMs();

    for (const row of rows) {
      try {
        const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) {
          deleteTicket.run(row.channel_id);
          continue;
        }

        const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!isTicketChannel(channel)) {
          deleteTicket.run(row.channel_id);
          continue;
        }

        if (!row.last_user_message_at) continue;

        const waitedMs = currentTime - row.last_user_message_at;

        if (!row.alerted_staff && waitedMs >= staffThresholdMs) {
          await sendStaffAlerts(guild, channel, row);
          row.alerted_staff = 1;
        }

        if (!row.alerted_owner && waitedMs >= ownerThresholdMs) {
          await sendOwnerAlert(channel, row);
          row.alerted_owner = 1;
        }

        row.updated_at = currentTime;
        upsertTicket.run(row);
      } catch (err) {
        console.error(`Sweep error for channel ${row.channel_id}:`, err);
      }
    }
  }, config.scan.intervalMinutes * 60 * 1000);
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    if (message.guild.id !== config.guildId) return;
    if (!isTicketChannel(message.channel)) return;

    const member =
      message.member ||
      (await message.guild.members.fetch(message.author.id).catch(() => null));

    if (!member) return;

    const staff = memberIsStaff(member);
    const existing = getTicket.get(message.channel.id);
    const timestamp = message.createdTimestamp || nowMs();

    if (staff) {
      upsertTicket.run({
        channel_id: message.channel.id,
        guild_id: message.guild.id,
        waiting_on_staff: 0,
        last_user_message_at: existing?.last_user_message_at ?? null,
        last_staff_message_at: timestamp,
        alerted_staff: 0,
        alerted_owner: 0,
        last_nonstaff_user_id: existing?.last_nonstaff_user_id ?? null,
        updated_at: nowMs(),
      });
    } else {
      const alreadyWaitingOnStaff = existing?.waiting_on_staff === 1;

      upsertTicket.run({
        channel_id: message.channel.id,
        guild_id: message.guild.id,
        waiting_on_staff: 1,
        last_user_message_at: alreadyWaitingOnStaff
          ? existing?.last_user_message_at ?? timestamp
          : timestamp,
        last_staff_message_at: existing?.last_staff_message_at ?? null,
        alerted_8h: alreadyWaitingOnStaff ? existing?.alerted_8h ?? 0 : 0,
        alerted_24h: alreadyWaitingOnStaff ? existing?.alerted_24h ?? 0 : 0,
        last_nonstaff_user_id: message.author.id,
        updated_at: nowMs(),
      });

      if (alreadyWaitingOnStaff) {
        console.log(`User sent another message, timer kept for ${message.channel.name}`);
      } else {
        console.log(`User message started waiting timer for ${message.channel.name}`);
      }
    }
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on("channelDelete", (channel) => {
  if (channel?.id) {
    deleteTicket.run(channel.id);
  }
});

client.login(config.botToken);
