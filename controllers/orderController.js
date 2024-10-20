const asyncWrapper = require("../middlewares/asyncWrapper");
const Order = require("../models/orderModel");
const OrderItem = require("../models/orderItemModel");
const Product = require("../models/productModel");
const User = require("../models/userModel");
// const crypto = require("crypto");
const {
  sendErrorResponse,
  sendSuccessResponse,
} = require("../utilities/sendResponse");
const checkIfIdIsValid = require("../middlewares/checkIfIdIsValid");
const checkIfProductExists = require("../middlewares/checkIfProductExists");
const checkIfUserExists = require("../middlewares/checkIfUserExists");
const {
  getPaymobToken,
  getPaymobOrderId,
  getPaymentKey,
} = require("./paymobController");

let orderDetails = {
  orderItems: [],
  order: {},
  productId: null,
};

const makeOrder = asyncWrapper(async (req, res) => {
  const {
    orderItems,
    shippingAddress1,
    shippingAddress2,
    city,
    zip,
    country,
    phone,
  } = req.body;

  let orderItemsArray = [];
  let orderItemsIds = [];
  for (const orderItem of orderItems) {
    if (!checkIfIdIsValid(orderItem.product)) {
      return sendErrorResponse(res, "Invalid product ID", 404, {
        product: {
          message: "Invalid product ID",
        },
      });
    }
    if (!(await checkIfProductExists(orderItem.product))) {
      return sendErrorResponse(res, "Product not found", 404, {
        product: {
          message: "Product not found",
        },
      });
    }
    let newOrderItem = new OrderItem({
      product: orderItem.product,
      quantity: orderItem.quantity,
    });
    orderItemsArray.push(newOrderItem);
    orderItemsIds.push(newOrderItem._id);
  }

  let subTotalPrice = 0;
  let totalPrice = 0;
  let subTotalPriceAfterDiscount = 0;
  let totalPriceAfterDiscount = 0;

  for (const orderItemOfArr of orderItemsArray) {
    const product = await Product.findById(orderItemOfArr.product).select(
      "price discount"
    );

    // Calculate subTotalPrice before discount
    subTotalPrice = orderItemOfArr.quantity * product.price;
    orderItemOfArr.subTotalPrice = subTotalPrice;

    // Calculate subTotalPrice after discount
    const discount = product.discount / 100; // Convert discount to percentage
    subTotalPriceAfterDiscount = subTotalPrice * (1 - discount);
    orderItemOfArr.subTotalPriceAfterDiscount = subTotalPriceAfterDiscount;

    // Accumulate total prices
    totalPrice += subTotalPrice;
    totalPriceAfterDiscount += subTotalPriceAfterDiscount;
  }

  orderDetails.orderItems = orderItemsArray;
  orderDetails.order = {
    orderItems: orderItemsIds,
    shippingAddress1,
    shippingAddress2,
    city,
    zip,
    country,
    phone,
    user: req.currentUser.id,
    totalPrice,
    totalPriceAfterDiscount,
  };

  // Step 1: Authenticate with Paymob
  const paymobToken = await getPaymobToken();

  // Step 2: Register Order with Paymob
  const priceWithCents = Math.round(totalPriceAfterDiscount * 100);
  const paymobOrderId = await getPaymobOrderId(paymobToken, priceWithCents);

  // Step 3: Generate Payment Key for Paymob
  if (!checkIfIdIsValid(req.currentUser.id)) {
    return sendErrorResponse(res, "Invalid user ID", 404, {
      user: {
        message: "Invalid user ID",
      },
    });
  }
  if (!(await checkIfUserExists(req.currentUser.id))) {
    return sendErrorResponse(res, "User not found", 404, {
      user: {
        message: "User not found",
      },
    });
  }
  const user = await User.findById(req.currentUser.id).select(
    "firstName lastName email"
  );
  const billingData = {
    first_name: user.firstName,
    last_name: user.lastName,
    email: user.email,
    phone_number: phone,
    address: shippingAddress1,
    building: "NA",
    city,
    zip: zip || "NA",
    country,
    apartment: "NA",
    floor: "NA",
    state: "NA",
    street: "NA",
  };
  const paymentKey = await getPaymentKey(
    paymobToken,
    paymobOrderId,
    priceWithCents,
    billingData
  );

  // insert order item in database
  // return paymentKey;
  sendSuccessResponse(res, "Payment key returned successfully", 200, {
    paymentKey,
    frame_id: process.env.PAYMOB_FRAME_ID,
  });
});

const handleProcessedCallback = async (req, res) => {
  try {
    await OrderItem.insertMany(orderDetails.orderItems);

    let newOrder = new Order(orderDetails.order);
    newOrder.payment_status = "Paid";

    // insert order in database
    newOrder = await newOrder.save();

    if (!newOrder) {
      return sendErrorResponse(res, "Failed to make order", 500, {
        message: "Failed to make order",
      });
    }

    orderDetails.productId = newOrder._id;

    sendSuccessResponse(res, "Order created successfully", 201, newOrder);
  } catch (error) {
    return sendErrorResponse(res, "Error during payment process", 500, error);
  }
};

const handleResponseCallback = async (req, res) => {
  try {
    const { success, message } = req.query; // Adjust this based on your actual request structure
    const productId = orderDetails.productId;

    if (success === "true") {
      // If payment was successful
      // Redirect to the orders route with the productId
      res.redirect(`https://client-esw.vercel.app/my-orders/${productId}`);
    } else {
      // If payment failed
      // Redirect to an error page or the same route with an error message
      res.redirect(
        `https://client-esw.vercel.app/checkOut?error=${encodeURIComponent(
          message || "There was an issue with your payment."
        )}`
      );
    }
  } catch (error) {
    return sendErrorResponse(
      res,
      "Error handling response callback",
      500,
      error
    );
  }
};

const getOrders = asyncWrapper(async (req, res) => {
  const totalOrders = await Order.countDocuments();
  const query = req.query;
  const limit = query.limit ? parseInt(query.limit, 10) : totalOrders; // If limit is not provided, use total count
  const page = query.page || 1;
  const skip = (page - 1) * limit;

  const orders = await Order.find({})
    .populate("user", "firstName lastName")
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
  sendSuccessResponse(res, "Orders fetched successfully", 200, {
    "Total Orders": totalOrders,
    orders,
  });
});

const getMyOrders = asyncWrapper(async (req, res) => {
  const userId = req.currentUser.id;

  // Find all orders where the userId matches the provided userId
  const orders = await Order.find({ user: userId })
    .populate({
      path: "orderItems",
      populate: { path: "product", populate: "category" },
    })
    .populate("user", "firstName lastName");

  if (!orders || orders.length === 0) {
    return sendErrorResponse(res, "No orders found for this user", 404, {
      orders: { message: "No orders found for this user." },
    });
  }
  sendSuccessResponse(res, "Orders fetched successfully", 200, orders);
});

const getMyOrderById = asyncWrapper(async (req, res) => {
  const userId = req.currentUser.id; // Get the current user ID
  const { orderId } = req.params; // Get the order ID from the request parameters

  // Find the specific order where both the order ID and user ID match
  const order = await Order.findOne({ _id: orderId, user: userId })
    .populate({
      path: "orderItems",
      populate: { path: "product", populate: "category" },
    })
    .populate("user", "firstName lastName");

  // If no order is found or it does not belong to the user
  if (!order) {
    return sendErrorResponse(res, "Order not found for this user", 404, {
      order: { message: "No order found for this user." },
    });
  }

  // Send the order if found
  sendSuccessResponse(res, "Order fetched successfully", 200, order);
});

const getOrder = asyncWrapper(async (req, res) => {
  if (!checkIfIdIsValid(req.params.id)) {
    return sendErrorResponse(res, "Invalid order ID", 404, {
      order: {
        message: "Invalid order ID",
      },
    });
  }

  const order = await Order.findById(req.params.id)
    .populate("user", "firstName lastName")
    .populate({
      path: "orderItems",
      populate: { path: "product", populate: "category" },
    });

  if (!order) {
    return sendErrorResponse(res, "Order not found", 404, {
      order: {
        message: "Order not found",
      },
    });
  }
  sendSuccessResponse(res, "Order fetched successfully", 200, order);
});

const updateOrder = asyncWrapper(async (req, res) => {
  if (!checkIfIdIsValid(req.params.id)) {
    return sendErrorResponse(res, "Invalid order ID", 404, {
      order: {
        message: "Invalid order ID",
      },
    });
  }

  const updatedOrder = await Order.findByIdAndUpdate(
    req.params.id,
    {
      status: req.body.status,
    },
    { new: true, runValidators: true }
  );
  if (!updatedOrder) {
    return sendErrorResponse(res, "Order not found", 404, {
      order: {
        message: "Order not found",
      },
    });
  }
  sendSuccessResponse(res, "Order updated successfully", 200, updatedOrder);
});

const deleteOrder = asyncWrapper(async (req, res) => {
  if (!checkIfIdIsValid(req.params.id)) {
    return sendErrorResponse(res, "Invalid order ID", 404, {
      order: {
        message: "Invalid order ID",
      },
    });
  }

  const deletedOrder = await Order.findByIdAndDelete(req.params.id);
  deletedOrder.orderItems.map(async (orderItem) => {
    await OrderItem.findByIdAndDelete(orderItem);
  });
  if (!deletedOrder) {
    return sendErrorResponse(res, "Order not found", 404, {
      order: {
        message: "Order not found",
      },
    });
  }
  sendSuccessResponse(res, "Order deleted successfully", 200, deletedOrder);
});

module.exports = {
  makeOrder,
  handleProcessedCallback,
  handleResponseCallback,
  getOrders,
  getMyOrders,
  getMyOrderById,
  getOrder,
  updateOrder,
  deleteOrder,
};
