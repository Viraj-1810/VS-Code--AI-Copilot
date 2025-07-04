from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn

app = FastAPI()
model = SentenceTransformer("all-MiniLM-L6-v2")

class EmbeddingRequest(BaseModel):
    inputs: str

@app.post("/embed")
async def embed(req: EmbeddingRequest):
    emb = model.encode([req.inputs])
    return {"embedding": emb[0].tolist()}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000) 