# Образ Playwright: Chromium и все его системные библиотеки уже внутри.
# Так надёжнее, чем доставлять их к стандартной сборке Railway — там
# браузер падает на отсутствующих libnss3, libgbm и десятке других.
# Версия тега обязана совпадать с версией пакета playwright в
# package.json: иначе Playwright не найдёт свою сборку браузера.
FROM mcr.microsoft.com/playwright:v1.64.0-jammy

WORKDIR /app

# Браузеры лежат в образе, скачивать их при установке пакетов не нужно.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Сначала только манифесты: слой с зависимостями переиспользуется, пока
# они не менялись, и пересборка после правки кода идёт быстро.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --include=dev

COPY . .
RUN npm run build

# Миграции применяются перед стартом, как и при обычной сборке.
CMD ["npm", "run", "start"]
