import asyncio
import websockets
import os

async def test():
    key = os.environ.get("DEEPGRAM_API_KEY")
    url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=48000&channels=1&detect_language=true"
    headers = {"Authorization": f"Token {key}"}
    
    try:
        async with websockets.connect(url, additional_headers=headers) as ws:
            print("Successfully connected!")
            ws.close()
    except Exception as e:
        print("Failed:", e)

asyncio.run(test())
