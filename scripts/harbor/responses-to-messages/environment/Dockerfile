FROM python:3.12-slim
WORKDIR /app
COPY calc.py expected.txt ./
COPY backend claude-real gateway_lab.py start.sh settings.gpt.json /opt/responses-fixture/
COPY claude.sh /usr/local/bin/claude
RUN chmod +x /opt/responses-fixture/backend /opt/responses-fixture/claude-real \
    /opt/responses-fixture/start.sh /usr/local/bin/claude
ENTRYPOINT ["/opt/responses-fixture/start.sh"]
