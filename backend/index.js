// merged-app.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const { Telegraf } = require("telegraf");
const cron = require("node-cron");

// Initialize Express app
const app = express();
const port = process.env.PORT || 3001;

// Initialize Telegram bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Setup database
const adapter = new FileSync("db.json");
const db = low(adapter);

// Set default data if db.json is empty
db.defaults({
  users: [],
  schedules: [],
  workouts: [],
  meals: [],
  currentWeeks: [],
}).write();

// Enable CORS for all origins (for development - adjust for production!)
app.use(cors());
app.use(bodyParser.json());

// --- Helper Functions ---

// Fetch schedule data 
function getSchedule(chatId) {
  const schedule = db
    .get("schedules")
    .find({ chatId: parseInt(chatId) })
    .value();

  if (schedule) {
    return schedule.tasks;
  } else {
    return null;
  }
}

// Fetch workout data
function getWorkout(chatId, week, day) {
  const workout = db
    .get("workouts")
    .find({ chatId: parseInt(chatId), week: parseInt(week), day: day })
    .value();

  return workout || null;
}

// Fetch meal data
function getMeal(chatId, day) {
  const meal = db
    .get("meals")
    .find({ chatId: parseInt(chatId), day: day })
    .value();

  return meal || null;
}

// Calculate which week the user is in based on start date
function calculateCurrentWeek(chatId) {
  const user = db
    .get("users")
    .find({ chatId: parseInt(chatId) })
    .value();

  if (!user || !user.startDate) {
    return 1; // Default to week 1 if no start date
  }

  const startDate = new Date(user.startDate);
  const currentDate = new Date();

  // Calculate difference in days
  const diffTime = Math.abs(currentDate - startDate);
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  // Calculate week number (1-indexed)
  const currentWeek = Math.floor(diffDays / 7) + 1;

  // Cap at max weeks
  return Math.min(currentWeek, 8);
}

// Get or update current week
function getCurrentWeek(chatId) {
  return calculateCurrentWeek(chatId);
}

// --- Bot Commands ---

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(
    `Welcome to your Fitness Tracker! 

Use /generate to create your 8-week fitness plan with workouts and meals.

You can view your progress in the mini-app.`
  );
});

bot.command("help", (ctx) => {
  ctx.reply(`
Available commands:
/start - Start the bot and get information.
/generate - Generate your 8-week fitness plan (first time setup).
/regenerate - Reset and create a new fitness plan.
/help - Show this help message.
    `);
});

bot.command("generate", async (ctx) => {
  const chatId = ctx.chat.id;
  const user = db
    .get("users")
    .find({ chatId: parseInt(chatId) })
    .value();

  if (user) {
    ctx.reply("You already have a fitness plan. Use /regenerate if you want to start over.");
    return;
  }

  // Create new user with start date
  db.get("users")
    .push({
      chatId: parseInt(chatId),
      startDate: new Date().toISOString(),
      progress: {}
    })
    .write();

  // Generate all required data
  generateSchedule(chatId);
  generateMealData(chatId);

  ctx.reply("Your 8-week fitness plan has been generated! Check the mini-app to view your schedule.");
});

bot.command("regenerate", async (ctx) => {
  const chatId = ctx.chat.id;

  // Remove all user data
  db.get("users")
    .remove({ chatId: parseInt(chatId) })
    .write();

  db.get("schedules")
    .remove({ chatId: parseInt(chatId) })
    .write();

  db.get("workouts")
    .remove({ chatId: parseInt(chatId) })
    .write();

  db.get("meals")
    .remove({ chatId: parseInt(chatId) })
    .write();

  // Create new user with current date
  db.get("users")
    .push({
      chatId: parseInt(chatId),
      startDate: new Date().toISOString(),
      progress: {}
    })
    .write();

  // Generate all required data
  generateSchedule(chatId);
  generateMealData(chatId);

  ctx.reply("Your fitness plan has been reset and regenerated! Check the mini-app to view your updated schedule.");
});

// --- Scheduled Notifications ---
function scheduleNotifications() {
  const allChatIds = db.get("users").map("chatId").value();

  for (const chatId of allChatIds) {
    const schedule = getSchedule(chatId);

    if (schedule) {
      for (const [time, task] of Object.entries(schedule)) {
        const [hour, minute] = time.split(":");

        cron.schedule(
          `${minute} ${hour} * * *`,
          async () => {
            const now = new Date();
            const currentDay = now.toLocaleString("en-us", { weekday: "long" });
            const currentWeek = calculateCurrentWeek(chatId);

            // Special Workout Message
            if (time === "17:00") {
              // Workout time
              const workout = getWorkout(chatId, currentWeek, currentDay);
              if (workout) {
                let workoutMessage = `Time to workout!\n\n*${workout.title}*\n${workout.description}`;
                if (workout.details) {
                  workoutMessage += `\n\n*Details:*\n${workout.details}`;
                }
                bot.telegram.sendMessage(chatId, workoutMessage, {
                  parse_mode: "Markdown",
                });
              } else {
                bot.telegram.sendMessage(
                  chatId,
                  `It's workout time! Check the mini-app for details.`
                );
              }
            }
            // Special Meal/Snack Messages
            else if (time === "16:00" || time === "22:00") {
              const mealType = time === "16:00" ? "snack" : "mainMeal";
              const meal = getMeal(chatId, currentDay);

              if (meal) {
                bot.telegram.sendMessage(
                  chatId,
                  `Time for your ${mealType === "snack" ? "snack" : "main meal"}!\n\n*${meal[mealType]}*`,
                  { parse_mode: "Markdown" }
                );
              } else {
                bot.telegram.sendMessage(
                  chatId,
                  `It's time for your ${mealType === "snack" ? "snack" : "main meal"}! Check the mini-app for details.`
                );
              }
            }
            // Regular schedule notification
            else {
              bot.telegram.sendMessage(
                chatId,
                `*${task.title}*\n${task.description}`,
                { parse_mode: "Markdown" }
              );
            }
          },
          {
            timezone: "Asia/Tehran", // Set to Iran Standard Time
          }
        );
      }
    }
  }
}

// --- API Endpoints ---

// Check if user exists
app.get("/user-exists", (req, res) => {
  const { chatId } = req.query;
  const user = db
    .get("users")
    .find({ chatId: parseInt(chatId) })
    .value();
  res.json(!!user); // Return true if user exists, false otherwise
});

// Get all chat IDs
app.get("/all-chat-ids", (req, res) => {
  const chatIds = db.get("users").map("chatId").value();
  res.json(chatIds);
});

// Get current week
app.get("/current-week", (req, res) => {
  const { chatId } = req.query;
  const currentWeek = calculateCurrentWeek(chatId);
  res.json({ week: currentWeek });
});

// Get start date
app.get("/start-date", (req, res) => {
  const { chatId } = req.query;
  const user = db
    .get("users")
    .find({ chatId: parseInt(chatId) })
    .value();

  if (!user || !user.startDate) {
    return res
      .status(404)
      .json({ message: "Start date not found for this user." });
  }
  res.json({ startDate: user.startDate });
});

// Get schedule - UPDATED to support day-specific schedules
app.get("/schedule", (req, res) => {
  const { chatId, day } = req.query;

  // If day is specified, return day-specific schedule
  if (day) {
    const schedule = getScheduleForDay(chatId, day);
    if (schedule) {
      res.json(schedule);
    } else {
      res.status(404).send({ message: "Schedule not found for this day" });
    }
  } else {
    // Otherwise return the general schedule (for backward compatibility)
    const schedule = getSchedule(chatId);
    if (schedule) {
      res.json(schedule);
    } else {
      res.status(404).send({ message: "Schedule not found" });
    }
  }
});

// New function to get schedule for a specific day
function getScheduleForDay(chatId, day) {
  const schedule = getSchedule(chatId);
  if (!schedule) return null;

  // Create a day-specific schedule by adding the day to each task key
  const daySchedule = {};
  for (const [time, task] of Object.entries(schedule)) {
    // For workout time, check if there's a workout for this day
    if (time === "17:00") {
      const currentWeek = calculateCurrentWeek(chatId);
      const workout = getWorkout(chatId, currentWeek, day);
      if (workout) {
        daySchedule[time] = {
          ...task,
          title: workout.title,
          description: workout.description
        };
      } else {
        daySchedule[time] = task;
      }
    }
    // For meal times, check if there's a meal for this day
    else if (time === "16:00" || time === "22:00") {
      const meal = getMeal(chatId, day);
      if (meal) {
        const mealType = time === "16:00" ? "snack" : "mainMeal";
        daySchedule[time] = {
          ...task,
          mealContent: meal[mealType]
        };
      } else {
        daySchedule[time] = task;
      }
    }
    // For regular schedule items
    else {
      daySchedule[time] = task;
    }
  }

  return daySchedule;
}

// Get workout
app.get("/workout", (req, res) => {
  const { chatId, week, day } = req.query;
  const workout = getWorkout(chatId, parseInt(week), day);
  if (workout) {
    res.json(workout);
  } else {
    res.status(404).send({ message: "Workout not found" });
  }
});

// Get meal
app.get("/meal", (req, res) => {
  const { chatId, day } = req.query;
  const meal = getMeal(chatId, day);
  if (meal) {
    res.json(meal);
  } else {
    res.status(404).send({ message: "Meal not found" });
  }
});

// --- Database Update Functions ---

// Update user's progress - UPDATED to support day-specific tasks
function updateProgress(chatId, task, week, completed) {
  // Find the user
  const user = db
    .get("users")
    .find({ chatId: parseInt(chatId) })
    .value();
  if (!user) {
    return; // User not found
  }

  // Initialize progress if it doesn't exist
  if (!user.progress) {
    user.progress = {};
  }
  if (!user.progress[week]) {
    user.progress[week] = {};
  }

  // Set the completion status for the task
  user.progress[week][task] = completed;

  // Update daily progress tracking
  if (!user.progress[week].daily) {
    user.progress[week].daily = {};
  }

  // Extract day from task ID if it's in the format "day_time"
  const taskParts = task.split('_');
  if (taskParts.length > 1) {
    const day = taskParts[0];

    // Initialize day tracking if needed
    if (!user.progress[week].daily[day]) {
      user.progress[week].daily[day] = { completed: 0, total: 0 };

      // Count total tasks for this day
      const dayTasks = Object.keys(user.progress[week]).filter(key =>
        key.startsWith(day + '_')
      );
      user.progress[week].daily[day].total = dayTasks.length;
    }

    // Count completed tasks for this day
    const completedDayTasks = Object.entries(user.progress[week])
      .filter(([key, value]) => key.startsWith(day + '_') && value === true)
      .length;

    user.progress[week].daily[day].completed = completedDayTasks;
  }

  // Update total progress for the week
  const totalTasks = Object.keys(user.progress[week])
    .filter(key => !key.includes('daily'))
    .length;

  const completedTasks = Object.entries(user.progress[week])
    .filter(([key, value]) => !key.includes('daily') && value === true)
    .length;

  user.progress[week].total = totalTasks;
  user.progress[week].completed = completedTasks;

  // Write the changes to the database
  db.get("users")
    .find({ chatId: parseInt(chatId) })
    .assign({ progress: user.progress })
    .write();
}

// Endpoint to update progress
app.post("/update-progress", (req, res) => {
  const { chatId, task, week, completed } = req.body;
  updateProgress(chatId, task, week, completed);
  res.json({
    message: "Progress updated successfully.",
    success: true
  });
});

// Endpoint to get progress - UPDATED to include daily progress
app.get("/get-progress", (req, res) => {
  const { chatId, week } = req.query;
  const user = db
    .get("users")
    .find({ chatId: parseInt(chatId) })
    .value();

  if (user && user.progress && user.progress[week]) {
    // If progress exists but daily tracking doesn't, initialize it
    if (!user.progress[week].daily) {
      user.progress[week].daily = {};

      // Group tasks by day and calculate progress
      const daysOfWeek = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

      daysOfWeek.forEach(day => {
        const dayTasks = Object.keys(user.progress[week]).filter(key =>
          key.startsWith(day + '_')
        );

        if (dayTasks.length > 0) {
          const completedDayTasks = dayTasks.filter(key =>
            user.progress[week][key] === true
          ).length;

          user.progress[week].daily[day] = {
            total: dayTasks.length,
            completed: completedDayTasks
          };
        }
      });

      // Save the updated progress with daily tracking
      db.get("users")
        .find({ chatId: parseInt(chatId) })
        .assign({ progress: user.progress })
        .write();
    }

    res.json(user.progress[week]);
  } else {
    // Initialize an empty progress object with daily tracking structure
    const emptyProgress = {
      daily: {},
      total: 0,
      completed: 0
    };
    res.json(emptyProgress);
  }
});

// --- Schedule, Workout, and Meal Generation ---

const scheduleData = {
  "10:00": {
    title: "☕ Black coffee or tea (optional)",
    description: "No milk/sugar, helps suppress hunger",
  },
  "12:00": { title: "🚰 500ml water", description: "Stay hydrated" },
  "14:00": {
    title: "🚰 More water or herbal tea",
    description: "Helps with satiety",
  },
  "16:00": {
    title: "Snack",
    description: "Today's scheduled snack"
  },
  "17:00": {
    title: "Workout (See schedule)",
    description: "This could be running, VR fitness, or a bodyweight circuit.",
  },
  "18:00": {
    title: "Post-workout water/shower",
    description: "Replenish fluids.",
  },
  "19:00": {
    title: "Free time/Relax",
    description: "Do whatever you want to spend your time",
  },
  "21:00": { title: "Prepare Dinner", description: "Cooking time." },
  "22:00": {
    title: "🍽️ Main Meal (OMAD) with Family",
    description: "Large, balanced meal",
  },
  "00:30": {
    title: "🚶 Light walk or stretch",
    description: "Helps digestion",
  },
  "01:30": {
    title: "🛏️ Sleep",
    description: "Supports muscle recovery & fat loss",
  },
};

// Function to generate meal data
function generateMealData(chatId) {
  const mealData = [];

  const meals = {
    Monday: {
      mainMeal: "Grilled chicken breast (150g) with 100g cooked rice, a large salad (cucumber, tomato, onion, bell pepper) with 1 tbsp olive oil and vinegar dressing.",
      snack: "Handful of almonds and a small apple."
    },
    Tuesday: {
      mainMeal: "Lean beef stir-fry (150g beef) with lots of vegetables (onions, peppers, mushrooms, zucchini) and 100g cooked rice. Use a low-sodium soy sauce and a little olive oil.",
      snack: "Greek yogurt with berries."
    },
    Wednesday: {
      mainMeal: "Baked chicken breast (150g) with roasted vegetables (carrots, green beans, asparagus) and a side of 100g cooked rice.",
      snack: "Protein shake with water."
    },
    Thursday: {
      mainMeal: "Healthy pasta with mixed vegetables and lean protein. 100g whole wheat pasta with grilled chicken and vegetables.",
      snack: "Handful of walnuts and a banana."
    },
    Friday: {
      mainMeal: "Grilled chicken salad (150g chicken) with a huge bed of mixed greens, cucumber, tomato, and a light vinaigrette dressing. 100g cooked rice on the side.",
      snack: "Greek yogurt with a few berries."
    },
    Saturday: {
      mainMeal: "Lean beef and vegetable kebabs (150g beef) with bell peppers, onions, and zucchini. Serve with 100g cooked rice.",
      snack: "Protein shake with water."
    },
    Sunday: {
      mainMeal: "Chicken breast (150g) baked with herbs and spices, served with a large portion of steamed vegetables (spinach, carrots, green beans) and 100g cooked rice.",
      snack: "A small handful of mixed nuts and an orange."
    }
  };

  // Create meal entries for each day
  Object.entries(meals).forEach(([day, mealInfo]) => {
    mealData.push({
      chatId: parseInt(chatId),
      day: day,
      mainMeal: mealInfo.mainMeal,
      snack: mealInfo.snack
    });
  });

  db.get("meals")
    .push(...mealData)
    .write();
}

// Function to generate workout data
function generateWorkoutData(chatId) {
  const workoutData = [];

  const workoutPlans = [
    {
      week: 1,
      schedule: {
        Monday: "Rest",
        Tuesday: "30 min VR fitness (moderate)",
        Wednesday: "Bodyweight Circuit 1",
        Thursday: "30 min Run (easy pace)",
        Friday: "Bodyweight Circuit 1",
        Saturday: "45 min VR fitness (moderate)",
        Sunday: "Rest",
      },
    },
    {
      week: 2,
      schedule: {
        Monday: "35 min Run (easy pace)",
        Tuesday: "Bodyweight Circuit 2",
        Wednesday: "40 min VR fitness (moderate)",
        Thursday: "Rest",
        Friday: "Bodyweight Circuit 2",
        Saturday: "50 min Run (easy pace)",
        Sunday: "Rest",
      },
    },
    {
      week: 3,
      schedule: {
        Monday: "Bodyweight Circuit 1",
        Tuesday: "45 min VR fitness (moderate/high)",
        Wednesday: "45 min Run (intervals: 2 min fast, 2 min slow)",
        Thursday: "Bodyweight Circuit 1",
        Friday: "Rest",
        Saturday: "60 min VR fitness (moderate/high)",
        Sunday: "Rest",
      },
    },
    {
      week: 4,
      schedule: {
        Monday: "50 min Run (intervals: 3 min fast, 2 min slow)",
        Tuesday: "Bodyweight Circuit 2",
        Wednesday: "Rest",
        Thursday: "50 min Run (steady pace)",
        Friday: "Bodyweight Circuit 2",
        Saturday: "Long walk (60+ min)",
        Sunday: "Rest",
      },
    },
    {
      week: 5,
      schedule: {
        Monday: "Rest",
        Tuesday: "VR fitness (moderate)",
        Wednesday: "Bodyweight Circuit 1",
        Thursday: "Run (easy pace)",
        Friday: "Bodyweight Circuit 1",
        Saturday: "VR fitness (moderate)",
        Sunday: "Rest",
      },
    },
    {
      week: 6,
      schedule: {
        Monday: "Run (easy pace)",
        Tuesday: "Bodyweight Circuit 2",
        Wednesday: "VR fitness (moderate)",
        Thursday: "Rest",
        Friday: "Bodyweight Circuit 2",
        Saturday: "Run (easy pace)",
        Sunday: "Rest",
      },
    },
    {
      week: 7,
      schedule: {
        Monday: "Bodyweight Circuit 1",
        Tuesday: "VR fitness (moderate/high)",
        Wednesday: "Run (intervals: 2 min fast, 2 min slow)",
        Thursday: "Bodyweight Circuit 1",
        Friday: "Rest",
        Saturday: "VR fitness (moderate/high)",
        Sunday: "Rest",
      },
    },
    {
      week: 8,
      schedule: {
        Monday: "Run (intervals: 3 min fast, 2 min slow)",
        Tuesday: "Bodyweight Circuit 2",
        Wednesday: "Rest",
        Thursday: "Run (steady pace)",
        Friday: "Bodyweight Circuit 2",
        Saturday: "Long walk (60+ min)",
        Sunday: "Rest",
      },
    },
  ];
  const bodyweightCircuits = {
    "Bodyweight Circuit 1": `
            Squats (10-15 reps)
            Push-ups (as many as possible with good form)
            Walking Lunges (10 reps per leg)
            Plank (30-60 seconds)
            Crunches (15-20 reps)
            Repeat circuit 2-3 times with 1-minute rest between circuits.
        `.trim(),
    "Bodyweight Circuit 2": `
            Jump Squats (10-12 reps)
            Incline Push-ups (using a chair or wall) (as many as possible)
            Reverse Lunges (10 reps per leg)
            Side Plank (30 seconds per side)
            Bicycle Crunches (15-20 reps)
            Repeat circuit 2-3 times with 1-minute rest between circuits.
        `.trim(),
    "Bodyweight Circuit Alternative": `
            Burpees (as good form as possible)
            Decline Push-ups (using a chair or wall)
            Glute Bridge (15-20 reps)
            Russian Twists ( 15-20 reps)
            Superman (hold for 30 seconds)
        `.trim(),
  };
  workoutPlans.forEach((plan) => {
    Object.entries(plan.schedule).forEach(([day, workoutName]) => {
      let details = "";
      if (workoutName.includes("Bodyweight Circuit")) {
        details = bodyweightCircuits[workoutName];
      }
      if (workoutName.includes("Run")) {
        details = `
            Start with a pace you can maintain comfortably.
            Gradually increase the duration of your runs.
            Incorporate intervals (alternating between fast and slow running) to boost calorie burn and improve fitness.
            `;
      }
      workoutData.push({
        chatId: parseInt(chatId),
        week: plan.week,
        day: day,
        title: workoutName,
        description: `Workout for ${day}`,
        details: details,
      });
    });
  });

  db.get("workouts")
    .push(...workoutData)
    .write();
}

// Function to generate the schedule
function generateSchedule(chatId) {
  const existingSchedule = db
    .get("schedules")
    .find({ chatId: parseInt(chatId) })
    .value();

  if (!existingSchedule) {
    db.get("schedules")
      .push({ chatId: parseInt(chatId), tasks: scheduleData })
      .write();

    // Generate workout data for new users
    generateWorkoutData(parseInt(chatId));
  }
}

// Start Express server and Telegram bot
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);

  // Launch the Telegram bot
  bot.launch(() => {
    console.log("Telegram bot started");
    scheduleNotifications();
  })
    .catch((err) => {
      console.error("Failed to start bot:", err);
    });
});

// Enable graceful stop
process.once("SIGINT", () => {
  bot.stop("SIGINT");
  console.log("Server shutting down");
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  console.log("Server shutting down");
});
