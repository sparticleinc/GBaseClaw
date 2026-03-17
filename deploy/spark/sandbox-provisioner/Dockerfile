# Use gbase-openclaw image which already has everything (python, bash, curl, git)
# and is already cached on Spark
FROM gbase-openclaw

WORKDIR /app
COPY provision.sh server.py ./
RUN chmod +x provision.sh

EXPOSE 8090

CMD ["python3", "server.py"]
