// Current Slide
let slideIndex = 0;

// Prev / next controls
function plusSlides(n) {
  slideIndex += n;
  showSlides(slideIndex);
}

// Dot controls
function currentSlide(n) {
  slideIndex = n;
  showSlides(slideIndex);
}

function showSlides(n) {
  // Get all slides
  let $slides = $(".slide");
  let $dots = $(".dot");

  // Make sure index in bounds
  slideIndex = n > $slides.length-1 ? 0 : slideIndex;
  slideIndex = n < 0 ? $slides.length-1 : slideIndex;

  // Enable current slide, disable all others
  $slides.each(function(index) {
    if(index === slideIndex) {
      $(this).css("display", "block");
    } else {
      $(this).css("display", "none");
    }
  })

  // Enable current dot, disable all others
  $dots.each(function(index) {
    if(index === slideIndex) {
      $(this).addClass("active");
    } else {
      $(this).removeClass("active");
    }
  })
}