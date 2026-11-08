FROM python:3.12-alpine

WORKDIR /app
COPY . .

# 账号库挂载点（docker run -v $(pwd)/.data:/app/.data 持久化）
RUN mkdir -p /app/.data

ENV PORT=8080
EXPOSE 8080

CMD ["python", "server.py"]
