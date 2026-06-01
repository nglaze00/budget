import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, Alert, Modal, Pressable } from "react-native";
import { useFocusEffect } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/Screen";
import { Card, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { colors, font, radius, spacing } from "@/theme";
import { getSetting, setSetting } from "@/lib/settings";
import { getLastSyncedAt } from "@/lib/data";
import { relativeTime } from "@/lib/format";
import { syncBothWays, exportSnapshotFile, importSnapshotJson, pingDesktop } from "@/lib/syncClient";
import type { MergeStats } from "@/lib/syncEngine";

type ConnStatus = "unknown" | "online" | "offline";

export default function SyncScreen() {
  const [peer, setPeer] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<ConnStatus>("unknown");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [result, setResult] = useState<{ pulled: MergeStats; pushed: MergeStats } | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [importText, setImportText] = useState("");
  const scannedRef = useRef(false);

  const refresh = useCallback(async () => {
    const p = await getSetting("desktop_peer_url");
    setPeer(p || null);
    setLastSync(await getLastSyncedAt());
  }, []);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!peer) { setConnStatus("unknown"); return; }
    setConnStatus("unknown");
    pingDesktop(peer).then((ok) => setConnStatus(ok ? "online" : "offline"));
  }, [peer]);

  async function onQrScanned(url: string) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setScanning(false);
    await setSetting("desktop_peer_url", url);
    setPeer(url);
  }

  async function doSync() {
    try {
      setBusy(true); setResult(null);
      const r = await syncBothWays();
      setResult(r);
      setLastSync(await getLastSyncedAt());
      setConnStatus("online");
    } catch (e) {
      setConnStatus("offline");
      Alert.alert("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen onRefresh={refresh} contentStyle={{ gap: spacing(4), paddingBottom: spacing(8) }}>

      {/* ── Connection header ── */}
      <Card>
        <View style={styles.connRow}>
          <View style={[styles.dot,
            connStatus === "online" ? styles.dotOn :
            connStatus === "offline" ? styles.dotOff : styles.dotUnknown]} />
          <View style={{ flex: 1 }}>
            {peer ? (
              <>
                <Text style={styles.connLabel} numberOfLines={1}>{peer}</Text>
                <Text style={styles.connSub}>Last synced: {relativeTime(lastSync)}</Text>
              </>
            ) : (
              <Text style={styles.connLabel}>Not configured</Text>
            )}
          </View>
          <Pressable
            onPress={() => { scannedRef.current = false; setScanning(true); }}
            style={styles.rescan} hitSlop={12}
          >
            <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
            <Text style={styles.rescanText}>{peer ? "Re-scan" : "Scan QR"}</Text>
          </Pressable>
        </View>
        {!peer && (
          <Text style={styles.hint}>
            On the desktop, open the <Text style={styles.em}>Sync</Text> page — it shows a QR
            code. Tap <Text style={styles.em}>Scan QR</Text> above to set up in one shot. After
            that, sync is a single tap.
          </Text>
        )}
      </Card>

      {/* ── Primary action ── */}
      {peer ? (
        <Button
          title={busy ? "Syncing…" : "⇅  Sync"}
          onPress={doSync}
          loading={busy}
          disabled={busy}
        />
      ) : (
        <Button
          title="📷  Scan desktop QR"
          onPress={() => { scannedRef.current = false; setScanning(true); }}
        />
      )}

      {/* ── Result ── */}
      {result && (
        <Card>
          <CardTitle>Synced ✓</CardTitle>
          <BothStats pulled={result.pulled} pushed={result.pushed} />
        </Card>
      )}

      {/* ── Offline fallback (collapsed) ── */}
      <Card>
        <Pressable onPress={() => setShowOffline((s) => !s)} style={styles.fallbackHeader}>
          <CardTitle>Offline fallback</CardTitle>
          <Ionicons name={showOffline ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
        </Pressable>
        {showOffline && (
          <>
            <Text style={styles.body}>Not on the same Wi-Fi? Share a snapshot file instead.</Text>
            <Button
              title="Export snapshot"
              variant="secondary"
              onPress={async () => {
                try { setBusy(true); await exportSnapshotFile(); }
                catch (e) { Alert.alert("Export failed", String(e)); }
                finally { setBusy(false); }
              }}
              loading={busy}
              disabled={busy}
            />
            <TextInput
              value={importText}
              onChangeText={setImportText}
              placeholder="Paste snapshot JSON here to import…"
              placeholderTextColor={colors.textFaint}
              multiline
              style={styles.textarea}
            />
            {importText.trim().length > 0 && (
              <Button
                title="Merge pasted snapshot"
                onPress={async () => {
                  try {
                    setBusy(true);
                    const stats = await importSnapshotJson(importText);
                    setResult({ pulled: stats, pushed: stats });
                    setImportText(""); setShowOffline(false);
                    setLastSync(await getLastSyncedAt());
                  } catch (e) { Alert.alert("Import failed", String(e)); }
                  finally { setBusy(false); }
                }}
                loading={busy}
                disabled={busy}
              />
            )}
          </>
        )}
      </Card>

      {/* ── QR scanner modal ── */}
      <QrScanModal
        visible={scanning}
        onScanned={onQrScanned}
        onClose={() => setScanning(false)}
      />
    </Screen>
  );
}

function QrScanModal({ visible, onScanned, onClose }: {
  visible: boolean; onScanned: (url: string) => void; onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.scanModal}>
        <View style={styles.scanHeader}>
          <Text style={styles.scanTitle}>Scan desktop QR code</Text>
          <Pressable onPress={onClose} hitSlop={16}>
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        <Text style={styles.scanSub}>
          On your laptop, open the <Text style={styles.em}>Sync</Text> page and point the camera
          at the QR code. This only needs to be done once.
        </Text>
        {!permission ? (
          <View style={styles.permBox}><Text style={styles.permText}>Loading…</Text></View>
        ) : !permission.granted ? (
          <View style={styles.permBox}>
            <Text style={styles.permText}>Camera access is needed to scan the QR code.</Text>
            <Button title="Grant camera permission" onPress={requestPermission} />
          </View>
        ) : (
          <View style={{ flex: 1, overflow: "hidden", borderRadius: radius.lg }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                if (/^https?:\/\//i.test(data)) onScanned(data);
              }}
            />
            <View style={styles.overlay} pointerEvents="none">
              <View style={styles.reticle} />
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function BothStats({ pulled, pushed }: { pulled: MergeStats; pushed: MergeStats }) {
  const rows: [string, string][] = [
    ["New transactions (from desktop)", String(pulled.rawAppended)],
    ["Transactions processed", String(pulled.processed)],
    ["Category/note overrides merged", String(Math.max(pulled.overridesApplied, pushed.overridesApplied))],
    ["Paycheck splits merged", String(Math.max(pulled.splitsApplied, pushed.splitsApplied))],
    ["Planning updated", pulled.planningUpdated || pushed.planningUpdated ? "yes" : "no"],
    ["Bank access adopted", pulled.connectionAdopted || pushed.connectionAdopted ? "yes" : "no"],
  ];
  return (
    <View style={{ gap: spacing(1) }}>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.statRow}>
          <Text style={styles.statKey}>{k}</Text>
          <Text style={styles.statVal}>{v}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  connRow: { flexDirection: "row", alignItems: "center", gap: spacing(3) },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  dotOn: { backgroundColor: "#22c55e" },
  dotOff: { backgroundColor: "#ef4444" },
  dotUnknown: { backgroundColor: colors.textFaint },
  connLabel: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.semibold },
  connSub: { color: colors.textFaint, fontSize: font.size.xs, marginTop: 2 },
  rescan: { flexDirection: "row", alignItems: "center", gap: spacing(1), paddingLeft: spacing(2) },
  rescanText: { color: colors.accent, fontSize: font.size.sm, fontWeight: font.weight.medium },
  hint: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20, marginTop: spacing(3) },
  em: { color: colors.text, fontWeight: font.weight.semibold },
  fallbackHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  body: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20 },
  textarea: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, color: colors.text, paddingHorizontal: spacing(3), paddingVertical: spacing(3), fontSize: font.size.base, minHeight: 100, textAlignVertical: "top" },
  statRow: { flexDirection: "row", justifyContent: "space-between" },
  statKey: { color: colors.textMuted, fontSize: font.size.sm },
  statVal: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.semibold },
  scanModal: { flex: 1, backgroundColor: colors.bg, padding: spacing(5), gap: spacing(3) },
  scanHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing(4) },
  scanTitle: { color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.bold },
  scanSub: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20 },
  permBox: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing(4) },
  permText: { color: colors.textMuted, fontSize: font.size.sm, textAlign: "center" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticle: { width: 220, height: 220, borderColor: colors.accent, borderWidth: 2, borderRadius: radius.lg, opacity: 0.8 },
});
