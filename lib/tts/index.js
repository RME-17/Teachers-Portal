const chatterbox = require("./chatterbox");
const modelLabel = String(process.env.RME_CHATTERBOX_MODEL || "turbo").trim().toLowerCase() === "original" ? "chatterbox-base" : "chatterbox-turbo";

async function synthesize(opts) {
	const result = await chatterbox.synthesize(opts);
	return { ...result, provider: modelLabel };
}

async function synthesizeStreaming(opts) {
	const result = await chatterbox.synthesizeStreaming(opts);
	return { ...result, provider: modelLabel };
}

async function synthesizeUtterance(opts) {
	const result = await chatterbox.synthesizeUtterance(opts);
	return { ...result, provider: modelLabel };
}

async function warmTts() {
	return chatterbox.warmTts();
}

function ttsReady() {
	return chatterbox.ttsReady();
}

function getTtsStatus() {
	return chatterbox.getTtsStatus();
}

function shutdown() {
	if (typeof chatterbox.shutdown === "function") {
		return chatterbox.shutdown();
	}
}

function getTtsVoice() {
	return chatterbox.getTtsVoice();
}

function setVoice(name) {
	return chatterbox.setVoice(name);
}

module.exports = {
	synthesize,
	synthesizeStreaming,
	synthesizeUtterance,
	warmTts,
	ttsReady,
	getTtsStatus,
	getTtsVoice,
	setVoice,
	shutdown,
};
