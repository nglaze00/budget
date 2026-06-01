import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "@/theme";
import { runCategorizeChat } from "@/lib/chat";
import type { ChatMessage, ChatStep } from "@/lib/openai";

interface UiMessage {
  role: "user" | "assistant";
  text: string;
  steps?: ChatStep[];
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<UiMessage[]>([
    { role: "assistant", text: "Tell me a rule like “MBTA is always Transit” and I'll preview, then bulk-apply it." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const next: UiMessage[] = [...messages, { role: "user", text }];
    setMessages(next);
    setBusy(true);
    try {
      const history: ChatMessage[] = next
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.text }));
      const { text: reply, steps } = await runCategorizeChat(history);
      const toolSteps = steps.filter((s) => s.type === "tool_call");
      setMessages((prev) => [...prev, { role: "assistant", text: reply, steps: toolSteps }]);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", text: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
          {messages.map((m, i) => (
            <View key={i} style={[styles.bubbleWrap, m.role === "user" ? styles.userWrap : styles.botWrap]}>
              {m.steps && m.steps.length > 0 && (
                <View style={styles.steps}>
                  {m.steps.map((s, j) => (
                    <Text key={j} style={styles.stepText}>⚙ {s.name}({compact(s.args)})</Text>
                  ))}
                </View>
              )}
              <View style={[styles.bubble, m.role === "user" ? styles.userBubble : styles.botBubble]}>
                <Text style={[styles.bubbleText, m.role === "user" && styles.userText]}>{m.text}</Text>
              </View>
            </View>
          ))}
          {busy && (
            <View style={[styles.bubbleWrap, styles.botWrap]}>
              <View style={[styles.bubble, styles.botBubble]}><ActivityIndicator color={colors.accent} /></View>
            </View>
          )}
        </ScrollView>

        <View style={styles.inputBar}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Type a categorization rule…"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            multiline
            onSubmitEditing={send}
          />
          <Pressable onPress={send} style={[styles.sendBtn, (!input.trim() || busy) && styles.sendDisabled]} disabled={!input.trim() || busy}>
            <Ionicons name="arrow-up" size={20} color="#04210f" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function compact(args?: Record<string, unknown>): string {
  if (!args) return "";
  return Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ").slice(0, 60);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing(4), gap: spacing(3) },
  bubbleWrap: { maxWidth: "90%", gap: spacing(1) },
  userWrap: { alignSelf: "flex-end" },
  botWrap: { alignSelf: "flex-start" },
  bubble: { borderRadius: radius.lg, paddingHorizontal: spacing(3), paddingVertical: spacing(3) },
  userBubble: { backgroundColor: colors.accent },
  botBubble: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  bubbleText: { color: colors.text, fontSize: font.size.base, lineHeight: 21 },
  userText: { color: "#04210f", fontWeight: font.weight.medium },
  steps: { gap: 2 },
  stepText: { color: colors.textFaint, fontSize: font.size.xs, fontFamily: "monospace" },
  inputBar: { flexDirection: "row", alignItems: "flex-end", gap: spacing(2), padding: spacing(3), borderTopColor: colors.border, borderTopWidth: 1, backgroundColor: colors.bg },
  input: { flex: 1, maxHeight: 120, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, color: colors.text, paddingHorizontal: spacing(3), paddingVertical: spacing(3), fontSize: font.size.base },
  sendBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.4 },
});
