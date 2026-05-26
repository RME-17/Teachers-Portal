const chatterbox = require("./chatterbox");

async function synthesize(opts) {
	const result = await chatterbox.synthesize(opts);
	return { ...result, provider: "chatterbox-turbo" };
}

async function synthesizeStreaming(opts) {
	const result = await chatterbox.synthesizeStreaming(opts);
	return { ...result, provider: "chatterbox-turbo" };
}

async function synthesizeUtterance(opts) {
	const result = await chatterbox.synthesizeUtterance(opts);
	return { ...result, provider: "chatterbox-turbo" };
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
