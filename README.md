# Taxidi 🗺️

Taxidi is an AI-powered collaborative trip-planning application designed for groups of friends and families who want to plan incredible trips on a budget. By leveraging advanced agentic AI, Taxidi takes the stress out of group coordination and itinerary building.

## 🎯 Chosen Vertical
**Collaborative Agentic Trip Planning**
We target budget-conscious travelers—specifically groups of friends and families. Coordinating group travel is notoriously difficult, especially when balancing different budgets, schedules, and preferences. Taxidi acts as your group's personal travel agent, facilitating collaboration and using intelligent tools to find the best activities, routes, and budget-friendly options.

## 🧠 Approach and Logic
Our architecture is designed for speed, edge-ready AI execution, and robust security:

- **Next.js:** Chosen specifically because it is the best framework for running AI agents on the edge, ensuring lightning-fast streaming responses during chat and itinerary generation.
- **Clerk Authentication:** Handles secure user management and authentication natively, ensuring critical user details are protected without custom boilerplate.
- **PostgreSQL:** A separate, dedicated database for storing non-security-critical application data (like generated itineraries, group workspaces, and saved places).
- **Google Cloud Run:** Provides scalable, effortless serverless hosting for our containerized Next.js application.
- **Agentic AI Tools:** The core logic relies on empowering the AI agent with a suite of "crazy powerful tools." By integrating the **Google Places API**, **Google Geocoding API**, and **Google Search API**, the agent doesn't just guess—it actively searches the web, verifies locations, and maps out accurate routes in real-time.

## ⚙️ How the Solution Works
1. **Secure Onboarding:** Users sign up and log in securely via Clerk. They can then create a new trip or join a shared trip workspace with friends/family.
2. **Agent Interaction:** The group interacts with the Taxidi AI agent using natural language (e.g., "Plan a 4-day budget trip to Tokyo for 4 people").
3. **Tool Execution:** The AI agent interprets the request and dynamically calls external tools—using Google Search for the latest budget tips, Google Places for venue details, and Geocoding for accurate mapping.
4. **Collaborative Itinerary:** The agent generates a visual, actionable itinerary. Users in the group can chat with the agent to suggest changes, tweak specific days, and finalize their plans together.

## 📌 Assumptions Made
- **Budget Priority:** The application assumes users prioritize cost-effectiveness. The agent's underlying prompts and search logic lean heavily towards budget-friendly recommendations unless the user explicitly requests luxury options.
- **API Availability & Accuracy:** The core functionality assumes high availability and accuracy of external Google APIs (Places, Geocoding, Search) and LLM inference endpoints.
- **Real-Time Collaboration:** We assume users will have active internet connections while planning, as the agent requires real-time edge communication to function.

---
## 🚀 Getting Started Locally

First, ensure your `.env.local` is populated with the necessary API keys (Clerk, OpenAI/Gemini, Google APIs, and Database connection strings).

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the application.
