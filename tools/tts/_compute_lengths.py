phrases=[
"Hello.",
"Your payslip for May is ready to view.",
"Welcome to Recruit My English. Your interview with Talking Global is confirmed for tomorrow at three p.m. South African time. Please make sure your camera and microphone are working before the call.",
"Hi, this is a longer test to confirm the server stays stable on multi-sentence input. The first sentence sets context. The second sentence adds detail. The third sentence wraps up cleanly.",
"Okay, this is the longest one. I want to check whether real-time-factor stays under one for a paragraph-length response. Imagine this is the AI replying to a teacher who has just asked how their next payment will be calculated, including the U S D to Z A R rate, the platform fee, and the timing of the bank transfer. The audio should sound natural throughout, and the synthesis should still finish in less time than the audio itself plays."
]
for i,p in enumerate(phrases,1):
    print(i,len(p))
    # print(p)
