import React, { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, Alert, Pressable } from "react-native";
import { Screen } from "@/components/Screen";
import { Card, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { Money } from "@/components/Money";
import { colors, font, radius, spacing } from "@/theme";
import { getSetting, setSetting } from "@/lib/settings";
import { claimSetupToken, saveConnection, sync } from "@/lib/simplefin";
import { getConnection, listAccounts, setAccountType, AccountRow } from "@/lib/data";

const ACCOUNT_TYPES = ["depository", "credit", "investment"];

export default function SettingsScreen() {
  const [openaiKey, setOpenaiKey] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");

  const refresh = useCallback(async () => {
    setHasKey(!!(await getSetting("openai_key")));
    setModel((await getSetting("openai_model")) || "gpt-5.5");
    setConnected(!!(await getConnection()));
    setAccounts(await listAccounts());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function saveKey() {
    if (!openaiKey.trim()) return;
    await setSetting("openai_key", openaiKey.trim());
    setOpenaiKey("");
    setHasKey(true);
    Alert.alert("Saved", "OpenAI key stored securely on this device.");
  }

  async function saveModel() {
    await setSetting("openai_model", model.trim() || "gpt-5.5");
    Alert.alert("Saved", `Model set to ${model.trim() || "gpt-5.5"}.`);
  }

  async function claim() {
    try {
      setBusy("claim");
      const accessUrl = await claimSetupToken(setupToken.trim());
      await saveConnection(accessUrl);
      setSetupToken("");
      setConnected(true);
      // Match desktop "Save + sync": on initial setup, backfill 1 year.
      setProgress("Connected — backfilling the last year…");
      const res = await sync(365, (m) => setProgress(m));
      setProgress("");
      Alert.alert(
        "Connected + synced",
        `${res.accounts} account(s)\n${res.raw_appended} transactions saved\n${res.categorized} categorized\n${res.paychecks_split} paychecks split`,
      );
      refresh();
    } catch (e) {
      setProgress("");
      Alert.alert("Setup failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function resync(days: number) {
    try {
      setBusy("sync");
      setProgress("Starting…");
      const res = await sync(days, (m) => setProgress(m));
      setProgress("");
      const problems = res.institutions.filter((i) => i.status !== "ok");
      const problemLine = problems.length
        ? `\n\nNeeds attention:\n${problems.map((p) => `• ${p.orgName}: ${p.status}`).join("\n")}`
        : "";
      Alert.alert(
        "Sync complete",
        `${res.accounts} account(s)\n${res.raw_appended} transactions saved\n${res.categorized} categorized\n${res.paychecks_split} paychecks split${problemLine}`,
      );
      refresh();
    } catch (e) {
      setProgress("");
      Alert.alert("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function cycleType(a: AccountRow) {
    const idx = ACCOUNT_TYPES.indexOf(a.accountType ?? "depository");
    const next = ACCOUNT_TYPES[(idx + 1) % ACCOUNT_TYPES.length];
    await setAccountType(a.accountId, next);
    setAccounts((prev) => prev.map((x) => (x.accountId === a.accountId ? { ...x, accountType: next } : x)));
  }

  return (
    <Screen onRefresh={refresh}>
      <Card>
        <CardTitle>OpenAI API key</CardTitle>
        <Text style={styles.body}>
          Powers categorization and the chat assistant. Stored only on this device (secure keystore).
          {hasKey ? "  ✓ A key is currently set." : "  No key set yet."}
        </Text>
        <TextInput
          value={openaiKey}
          onChangeText={setOpenaiKey}
          placeholder="sk-…"
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Button title="Save key" onPress={saveKey} disabled={!openaiKey.trim()} />
        <View style={styles.rowGap}>
          <TextInput value={model} onChangeText={setModel} placeholder="gpt-5.5" placeholderTextColor={colors.textFaint} autoCapitalize="none" style={[styles.input, { flex: 1 }]} />
          <Button title="Set model" variant="secondary" small onPress={saveModel} />
        </View>
      </Card>

      <Card>
        <CardTitle>Bank connection (SimpleFIN)</CardTitle>
        <Text style={styles.body}>
          {connected
            ? "✓ Connected. Tip: if your laptop already has access, you don't need a token here — just sync from the desktop on the Sync tab and this device inherits access."
            : "Paste a one-time SimpleFIN setup token to connect. Already set up on your laptop? Skip this and use the Sync tab instead."}
        </Text>
        {!connected && (
          <>
            <TextInput
              value={setupToken}
              onChangeText={setSetupToken}
              placeholder="SimpleFIN setup token…"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]}
            />
            <Button title="Claim token" onPress={claim} loading={busy === "claim"} disabled={!setupToken.trim() || !!busy} />
          </>
        )}
      </Card>

      <Card>
        <CardTitle>Fetch transactions</CardTitle>
        <Text style={styles.body}>
          Pull the latest from your banks, then categorize + split paychecks. "Re-sync now"
          grabs the last 90 days (same as the desktop app); use "Last year" for a deeper backfill.
        </Text>
        {progress ? <Text style={styles.progress}>{progress}</Text> : null}
        <View style={styles.rowGap}>
          <Button title="Re-sync now" onPress={() => resync(90)} loading={busy === "sync"} disabled={!connected || !!busy} style={{ flex: 1 }} />
          <Button title="Last year" variant="secondary" onPress={() => resync(365)} disabled={!connected || !!busy} style={{ flex: 1 }} />
        </View>
      </Card>

      <Card>
        <CardTitle>Accounts</CardTitle>
        <Text style={styles.body}>Tap an account to cycle its type (depository → credit → investment). This affects how spend is classified.</Text>
        {accounts.length === 0 && <Text style={styles.muted}>No accounts yet — fetch transactions first.</Text>}
        {accounts.map((a) => (
          <Pressable key={a.accountId} onPress={() => cycleType(a)} style={styles.acctRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.acctName} numberOfLines={1}>{a.orgName ?? "Bank"} · {a.name ?? a.accountId.slice(0, 8)}</Text>
              <Text style={styles.acctType}>{a.accountType ?? "depository"}</Text>
            </View>
            <Money value={a.balance} neutral />
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20 },
  muted: { color: colors.textFaint, fontSize: font.size.sm },
  progress: { color: colors.accentSoft, fontSize: font.size.sm },
  input: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, color: colors.text, paddingHorizontal: spacing(3), paddingVertical: spacing(3), fontSize: font.size.base },
  rowGap: { flexDirection: "row", gap: spacing(2), alignItems: "center" },
  acctRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing(2), borderTopColor: colors.borderSubtle, borderTopWidth: 1 },
  acctName: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.medium },
  acctType: { color: colors.accentSoft, fontSize: font.size.xs, textTransform: "uppercase", letterSpacing: 0.5 },
});
