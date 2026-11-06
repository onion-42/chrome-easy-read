// Built-in voices (chrome.tts: OS + Chrome voices). Free and offline; reports words when the voice can.

/** Speak text; send({event, ...}) gets start / word (charIndex) / end / error. */
export function speakBuiltin(text, { lang, rate }, send) {
  chrome.tts.stop();
  chrome.tts.speak(text, {
    lang: lang || undefined,
    rate,
    onEvent: (ev) => {
      if (ev.type === "start") send({ event: "start" });
      else if (ev.type === "word") send({ event: "word", charIndex: ev.charIndex });
      else if (ev.type === "end") send({ event: "end" });
      else if (ev.type === "error") send({ event: "error", message: `Built-in voice failed: ${ev.errorMessage || "unknown error"}` });
    },
  }).catch((e) => send({ event: "error", message: `Built-in voice failed: ${e.message}` }));
}

/** Best guess of the language when the page does not say (chrome.i18n uses Chrome's language detector). */
export async function detectLang(text) {
  const { isReliable, languages } = await chrome.i18n.detectLanguage(text);
  return isReliable && languages.length ? languages[0].language : "";
}
